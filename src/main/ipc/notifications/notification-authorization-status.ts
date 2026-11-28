import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type NotificationAuthorizationStatus = 'authorized' | 'denied' | 'not-determined' | 'unknown'

const HELPER_EXECUTABLE = 'orca-notification-status'
const HELPER_TIMEOUT_MS = 4000

let cachedHelperPathPromise: Promise<string | null> | null = null

/** Place the helper beside Electron in Contents/MacOS: bundle identity controls notification records, and macOS 26 aborts helpers under Resources (#7929). */
function resolveHelperPath(): Promise<string | null> {
  if (cachedHelperPathPromise) {
    return cachedHelperPathPromise
  }
  if (process.platform !== 'darwin') {
    cachedHelperPathPromise = Promise.resolve(null)
    return cachedHelperPathPromise
  }
  const candidate = join(dirname(process.execPath), HELPER_EXECUTABLE)
  cachedHelperPathPromise = access(candidate).then(
    () => candidate,
    () => null
  )
  return cachedHelperPathPromise
}

/** Read native authorization absent from Electron APIs; return null on helper failure so callers can use weaker delivery evidence. */
let readInFlight: Promise<NotificationAuthorizationStatus | null> | null = null

export function readNotificationAuthorizationStatus(): Promise<NotificationAuthorizationStatus | null> {
  // Share one helper read across simultaneous completion notifications.
  if (readInFlight) {
    return readInFlight
  }
  readInFlight = resolveHelperPath()
    .then((helperPath) => (helperPath ? runStatusHelper(helperPath) : null))
    .finally(() => {
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
