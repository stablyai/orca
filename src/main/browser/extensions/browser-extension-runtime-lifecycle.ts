import { emitBrowserExtensionWorkerStartEvent } from './browser-extension-api-host'
import {
  getBrowserExtensionProfileStateStore,
  type BrowserExtensionProfileState
} from './browser-extension-profile-state-store'

type LoadedVersions = NonNullable<BrowserExtensionProfileState['lastLoaded']>

/** startup: the profile's first load this launch; reload: Settings › Reload or a store update. */
export type BrowserExtensionLoadKind = 'startup' | 'reload' | 'other'

export type RuntimeLifecycleEvent = { event: 'onInstalled' | 'onStartup'; args: unknown[] }

/** What Chrome fires for one load, given the versions this profile last loaded. */
export function decideRuntimeLifecycleEvents(
  last: LoadedVersions | undefined,
  current: LoadedVersions,
  kind: BrowserExtensionLoadKind
): RuntimeLifecycleEvent[] {
  if (!last) {
    return [{ event: 'onInstalled', args: [{ reason: 'install' }] }]
  }
  const events: RuntimeLifecycleEvent[] =
    kind === 'startup' ? [{ event: 'onStartup', args: [] }] : []
  // Why reload counts: Chrome reports an unpacked reload as an update even at the same version.
  if (kind === 'reload' || last.extensionVersion !== current.extensionVersion) {
    events.push({
      event: 'onInstalled',
      args: [{ reason: 'update', previousVersion: last.extensionVersion }]
    })
  } else if (last.chromiumVersion !== current.chromiumVersion) {
    events.push({ event: 'onInstalled', args: [{ reason: 'chrome_update' }] })
  }
  return events
}

function hasServiceWorker(extension: Electron.Extension): boolean {
  const background: unknown = extension.manifest?.background
  return typeof background === 'object' && background !== null && 'service_worker' in background
}

/** Electron fires neither runtime.onInstalled nor onStartup; Orca raises them after each load. */
export function fireRuntimeLifecycleEvents(
  sess: Electron.Session,
  profileId: string,
  extension: Electron.Extension,
  kind: BrowserExtensionLoadKind
): void {
  const store = getBrowserExtensionProfileStateStore()
  const current = { extensionVersion: extension.version, chromiumVersion: process.versions.chrome }
  const last = store.read(profileId, extension.id).lastLoaded
  if (hasServiceWorker(extension)) {
    for (const { event, args } of decideRuntimeLifecycleEvents(last, current, kind)) {
      emitBrowserExtensionWorkerStartEvent(sess, extension.id, 'runtime', event, args)
    }
  }
  // Why after: a crash before the debounced write re-fires the event once rather than never.
  store.update(profileId, extension.id, (state) => ({ ...state, lastLoaded: current }))
}
