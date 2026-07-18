import type { FsChangeEvent } from '../../shared/types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  failSshFilesystemWatchRegistration,
  type WatchRegistration
} from './ssh-filesystem-provider-watch'

export function routeSshFilesystemWatchNotification(
  registrations: Map<string, WatchRegistration>,
  method: string,
  params: Record<string, unknown>
): void {
  if (method === 'fs.changed') {
    const events = params.events as FsChangeEvent[]
    for (const registration of registrations.values()) {
      const matching = events.filter((event) =>
        isPathInsideOrEqual(registration.rootPath, event.absolutePath)
      )
      if (matching.length > 0) {
        for (const callback of registration.callbacks) {
          callback(matching)
        }
      }
    }
    return
  }
  if (method !== 'fs.watchFailed') {
    return
  }
  const rootPath = typeof params.rootPath === 'string' ? params.rootPath : null
  const watchId = typeof params.watchId === 'number' ? params.watchId : null
  if (rootPath && watchId !== null) {
    const message =
      typeof params.message === 'string' ? params.message : 'remote file watcher failed'
    failSshFilesystemWatchRegistration(registrations, rootPath, watchId, new Error(message))
  }
}
