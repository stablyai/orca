// Single source of truth for the app's logs directory and the files inside it.
// macOS convention is `~/Library/Application Support/Orca/logs/`; Windows and
// Linux resolve the same intent via Electron's `userData` dir. Falls back to a
// homedir-derived path when Electron's `app` is unavailable (unit tests).

import { app } from 'electron'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

function getUserDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    // Tests — Electron's `app` may not be initialized. Use an OS-conventional
    // fallback so callers can resolve the path without the Electron runtime.
    const home = homedir()
    if (platform() === 'darwin') {
      return join(home, 'Library', 'Application Support', 'Orca')
    }
    if (platform() === 'win32') {
      return join(process.env.APPDATA ?? home, 'Orca')
    }
    return join(home, '.config', 'Orca')
  }
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
