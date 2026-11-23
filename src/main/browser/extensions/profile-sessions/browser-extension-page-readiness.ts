import { session } from 'electron'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { isLocalSshBrowserPartition } from '../../routing/local-host-partitions/local-ssh-browser-partitions'
import { browserRouteSessionRegistry } from '../../routing/sessions/browser-route-session-runtime'
import { linkBrowserExtensionsToRouteSession } from './browser-extension-route-sessions'
import { whenBrowserExtensionsStartFor } from './browser-extension-page-start'
import {
  noteBrowserPageClosed,
  noteBrowserPageOpened
} from '../../guest-lifecycle/browser-page-partition-presence'

/**
 * Starts the extensions a page in this partition runs and resolves once a page there may be
 * created, as a browser restores tabs only after the profile's extensions load: a request in flight
 * when a webRequest extension loads is dropped by Electron, so the page must not exist before then.
 * Resolves at once when nothing is starting, and early when `signal` aborts.
 */
export function whenBrowserPartitionReadyForPage(
  partition: string,
  signal?: AbortSignal
): Promise<void> {
  const profileId =
    browserSessionRegistry.profileIdForPartition(partition) ??
    (browserRouteSessionRegistry.isAllowedPartition(partition) ||
    isLocalSshBrowserPartition(partition)
      ? linkBrowserExtensionsToRouteSession(session.fromPartition(partition))
      : null)
  if (!profileId) {
    return Promise.resolve()
  }
  browserSessionRegistry.attachExtensions(profileId)
  const ready = whenBrowserExtensionsStartFor(profileId)
  if (!ready || !signal) {
    return ready ?? Promise.resolve()
  }
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    void ready.then(done)
  })
}

/** A page that waited here was never created: its extensions stop if no other page uses them. */
export function releaseBrowserPartitionIfIdle(partition: string): void {
  noteBrowserPageOpened(partition)
  noteBrowserPageClosed(partition)
}
