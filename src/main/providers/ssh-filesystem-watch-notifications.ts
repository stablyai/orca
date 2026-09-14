import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
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
    // Why normalize once: isPathInsideOrEqual NFC-normalizes both sides, so the
    // nested fan-out re-normalized every event path once per watch root.
    const normalizedEvents = events.map((event) => ({
      event,
      normalizedPath: normalizeRuntimePathForComparison(event.absolutePath)
    }))
    for (const registration of registrations.values()) {
      const isInsideRoot = createNormalizedPathInsideOrEqualMatcher(registration.rootPath)
      const matching = normalizedEvents
        .filter(({ normalizedPath }) => isInsideRoot(normalizedPath))
        .map(({ event }) => event)
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
