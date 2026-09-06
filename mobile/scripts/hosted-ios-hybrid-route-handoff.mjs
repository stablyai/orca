import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HOSTED_MOBILE_APP_ROUTE_URL } from './hosted-mobile-e2e-launch.mjs'

const execFileAsync = promisify(execFile)

export async function openHostedIosHybridRoute(
  emulator,
  _timeoutMs,
  openUrl = openHostedIosAppUrl
) {
  await openUrl(emulator.deviceUdid, HOSTED_MOBILE_APP_ROUTE_URL)
}

async function openHostedIosAppUrl(deviceUdid, url) {
  await execFileAsync('xcrun', ['simctl', 'openurl', deviceUdid, url])
}
