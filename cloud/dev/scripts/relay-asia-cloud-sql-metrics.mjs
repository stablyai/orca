import { spawnSync } from 'node:child_process'

function accessToken() {
  const result = spawnSync('gcloud', ['auth', 'print-access-token'], {
    encoding: 'utf8', timeout: 30_000
  })
  const token = result.stdout.trim()
  if (result.status !== 0 || token.length < 20) {
    throw new Error('Google access token is unavailable')
  }
  return token
}

export async function readCloudSqlBackends(environment, startedAt, endedAt) {
  const production = environment === 'production'
  if (!production && environment !== 'staging') throw new Error('Cloud SQL environment is invalid')
  const project = production ? 'onorca-cloud' : 'onorca-cloud-staging'
  const instance = production ? 'orca-cloud-auth-db' : 'orca-cloud-staging-auth-db'
  const url = new URL(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`)
  url.searchParams.set('filter', `metric.type = "cloudsql.googleapis.com/database/postgresql/num_backends" AND resource.labels.database_id = "${project}:${instance}"`)
  url.searchParams.set('interval.startTime', startedAt)
  url.searchParams.set('interval.endTime', endedAt)
  url.searchParams.set('aggregation.alignmentPeriod', '60s')
  url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_MAX')
  url.searchParams.set('aggregation.crossSeriesReducer', 'REDUCE_MAX')
  url.searchParams.set('view', 'FULL')
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken()}` },
    redirect: 'error', signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`Cloud SQL metric query returned ${response.status}`)
  return await response.json()
}
