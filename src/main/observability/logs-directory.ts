// Single source of truth for the app's logs directory and the files inside it.
// macOS convention is `~/Library/Application Support/Orca/logs/`; Windows and
// Linux resolve the same intent via the host's `userData` dir. Falls back to a
// homedir-derived path when no AppEnvironment is installed (unit tests).

import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// Why the port and not electron's `app`: the daemon launch path reads this for --log-file,
// and that path has to resolve under plain Node (orcad) as well as the desktop.
// Why 'userData' + 'logs' rather than getPath('logs'): electron's 'logs' is ~/Library/Logs
// on macOS, which is NOT where this app has ever written. Changing it would strand
// existing log bundles.
function getUserDataDir(): string {
  if (hasAppEnvironment()) {
    return getAppEnvironment().getPath('userData')
  }
  const home = homedir()
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Orca')
  }
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? home, 'Orca')
  }
  return join(home, '.config', 'Orca')
}

export function getLogsDirectory(): string {
  return join(getUserDataDir(), 'logs')
}

/** NDJSON trace file written by the main-process error-tracking sink. */
export function getTraceFilePath(): string {
  return join(getLogsDirectory(), 'main.trace.ndjson')
}

/** NDJSON lifecycle log written by the detached daemon process. Shared here so
 *  the daemon fork (which passes it as `--log-file`) and the bundle collector
 *  (which reads it) agree on one path. */
export function getDaemonLogFilePath(): string {
  return join(getLogsDirectory(), 'daemon.log')
}
