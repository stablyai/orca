import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type NotificationAuthorizationStatus = 'authorized' | 'denied' | 'not-determined' | 'unknown'

const HELPER_EXECUTABLE = 'orca-notification-status'
const HELPER_TIMEOUT_MS = 4000

let cachedHelperPath: string | null | undefined

/** Place the helper beside Electron in Contents/MacOS: bundle identity controls notification records, and macOS 26 aborts helpers under Resources (#7929). */
function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) {
    return cachedHelperPath
  }
  if (process.platform !== 'darwin') {
    cachedHelperPath = null
    return cachedHelperPath
  }
  const candidate = join(dirname(process.execPath), HELPER_EXECUTABLE)
  cachedHelperPath = existsSync(candidate) ? candidate : null
  return cachedHelperPath
}

/** Read native authorization absent from Electron APIs; return null on helper failure so callers can use weaker delivery evidence. */
let readInFlight: Promise<NotificationAuthorizationStatus | null> | null = null

export function readNotificationAuthorizationStatus(): Promise<NotificationAuthorizationStatus | null> {
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return Promise.resolve(null)
  }
  // Share one helper read across simultaneous completion notifications.
  if (readInFlight) {
    return readInFlight
  }
  readInFlight = runStatusHelper(helperPath).finally(() => {
    readInFlight = null
  })
  return readInFlight
}

function runStatusHelper(helperPath: string): Promise<NotificationAuthorizationStatus | null> {
  return new Promise((resolve) => {
    execFile(helperPath, [], { timeout: HELPER_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(String(stdout).trim()) as { authorization?: string }
        switch (parsed.authorization) {
          case 'authorized':
          case 'provisional':
          case 'ephemeral':
            resolve('authorized')
            return
          case 'denied':
            resolve('denied')
            return
          case 'not-determined':
            resolve('not-determined')
            return
          case undefined:
          default:
            resolve('unknown')
        }
      } catch {
        resolve(null)
      }
    })
  })
}
