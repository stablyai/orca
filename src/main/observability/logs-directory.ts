import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { ZOTZ_PRODUCT_NAME } from '../../shared/zotz/zotz-app-identity'

// Use the environment port for plain Node hosts. Keep userData/logs on macOS
// because Electron’s logs path would strand existing bundles.
function getUserDataDir(): string {
  if (hasAppEnvironment()) {
    return getAppEnvironment().getPath('userData')
  }
  const home = homedir()
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', ZOTZ_PRODUCT_NAME)
  }
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? home, ZOTZ_PRODUCT_NAME)
  }
  return join(home, '.config', ZOTZ_PRODUCT_NAME)
}

export function getLogsDirectory(): string {
  return join(getUserDataDir(), 'logs')
}

export function getTraceFilePath(): string {
  return join(getLogsDirectory(), 'main.trace.ndjson')
}

export function getOrcadTraceFilePath(): string {
  return join(getLogsDirectory(), 'orcad.trace.ndjson')
}

export function getDaemonLogFilePath(): string {
  return join(getLogsDirectory(), 'daemon.log')
}
