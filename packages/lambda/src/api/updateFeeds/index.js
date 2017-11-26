import Feed from 'feed'
import IncidentsStore from 'db/incidents'
import IncidentUpdatesStore from 'db/incidentUpdates'
import MaintenancesStore from 'db/maintenances'
import MaintenanceUpdatesStore from 'db/maintenanceUpdates'
import { SettingsProxy } from 'api/utils'
import S3 from 'aws/s3'
import CloudFormation from 'aws/cloudFormation'
import { stackName } from 'utils/const'
import { getDateTimeFormat } from 'utils/datetime'

export async function handle (event, context, callback) {
  try {
    const settings = new SettingsProxy()
    const statusPageURL = await settings.getStatusPageURL()
    const serviceName = await settings.getServiceName()
    const feed = new Feed({
      id: `tag:${statusPageURL},2017:/history`,
      link: statusPageURL,
      title: `${serviceName} Status - Incident History`,
      author: {
        name: serviceName
      }
    })

    let incidents = await new IncidentsStore().query()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayDate = yesterday.toISOString().replace(/T[0-9:.]+Z$/, '')
    incidents = incidents.map((incident) => {
      incident.createdAt = yesterdayDate + incident.createdAt.replace(/^[0-9-]+/, '')
      incident.updatedAt = yesterdayDate + incident.updatedAt.replace(/^[0-9-]+/, '')
      return incident
    })

    let maintenances = await new MaintenancesStore().query()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowDate = tomorrow.toISOString().replace(/T[0-9:.]+Z$/, '')
    maintenances = maintenances.map((maintenance) => {
      maintenance.createdAt = tomorrowDate + maintenance.createdAt.replace(/^[0-9-]+/, '')
      maintenance.updatedAt = tomorrowDate + maintenance.updatedAt.replace(/^[0-9-]+/, '')
      return maintenance
    })

    let events = incidents.concat(maintenances)
    events.sort(latestToOldest)
    const maxItems = 25
    for (let i = 0; i < Math.min(events.length, maxItems); i++) {
      feed.addItem(await buildItem(events[i], statusPageURL))
    }

    const { AWS_REGION: region } = process.env
    const bucket = await new CloudFormation(stackName).getStatusPageBucketName()
    const s3 = new S3()
    await s3.putObject(region, bucket, 'history.atom', feed.atom1())
    await s3.putObject(region, bucket, 'history.rss', feed.rss2())
    callback(null)
  } catch (error) {
    console.log(error.message)
    console.log(error.stack)
    callback('Error: failed to update the feeds')
  }
}

const latestToOldest = (a, b) => {
  if (a.createdAt < b.createdAt) return 1
  else if (b.createdAt < a.createdAt) return -1
  return 0
}

const buildItem = async (event, statusPageURL) => {
  let url = statusPageURL
  if (url.length > 0 && statusPageURL[statusPageURL.length - 1] === '/') {
    url = url.slice(0, url.length - 1)
  }

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayDate = yesterday.toISOString().replace(/T[0-9:.]+Z$/, '')

  let id, link, eventUpdates
  if (event.hasOwnProperty('incidentID')) {
    let incidentUpdates = await new IncidentUpdatesStore().query(event.incidentID)
    // Show the incident updates as if they have happened yesterday.
    incidentUpdates = incidentUpdates.map(incidentUpdate => {
      incidentUpdate.createdAt = yesterdayDate + incidentUpdate.createdAt.replace(/^[0-9-]+/, '')
      incidentUpdate.updatedAt = yesterdayDate + incidentUpdate.updatedAt.replace(/^[0-9-]+/, '')
      return incidentUpdate
    })
    incidentUpdates.sort(latestToOldest)

    id = `tag:${statusPageURL},2017:Incident/${event.incidentID}`
    link = `${url}/incidents/${event.incidentID}`
    eventUpdates = incidentUpdates.map(update => {
      update.status = update.incidentStatus
      return update
    })
  } else if (event.hasOwnProperty('maintenanceID')) {
    let maintenanceUpdates = await new MaintenanceUpdatesStore().query(event.maintenanceID)
    maintenanceUpdates = maintenanceUpdates.map(maintenanceUpdate => {
      maintenanceUpdate.createdAt = yesterdayDate + maintenanceUpdate.createdAt.replace(/^[0-9-]+/, '')
      maintenanceUpdate.updatedAt = yesterdayDate + maintenanceUpdate.updatedAt.replace(/^[0-9-]+/, '')
      return maintenanceUpdate
    })
    maintenanceUpdates.sort(latestToOldest)

    id = `tag:${statusPageURL},2017:Maintenance/${event.maintenanceID}`
    link = `${url}/maintenances/${event.maintenanceID}`
    eventUpdates = maintenanceUpdates.map(update => {
      update.status = update.maintenanceStatus
      return update
    })
  } else {
    throw new Error('Unknown event: ', event)
  }

  const content = eventUpdates.map(update => {
    return `<p><small>${getDateTimeFormat(update.createdAt)}</small><br><strong>${update.status}</strong> - ${update.message}</p>`
  }).join('')
  return {
    id,
    link,
    content,
    published: new Date(eventUpdates[0].createdAt),
    date: new Date(event.createdAt),
    title: event.name
  }
}
