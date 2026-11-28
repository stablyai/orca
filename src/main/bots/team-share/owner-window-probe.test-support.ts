// The owner's window, desktop and phones on a shared agent's host, as one recorder: a test does one
// teammate act in their own list and asserts the owner got nothing and sees nothing new.
import {
  getRuntimeDesktopSurface,
  setRuntimeDesktopSurface,
  type RuntimeDesktopSurface
} from '../../runtime/construction/runtime-desktop-surface'
import type { RuntimeNotifier } from '../../runtime/client/events/runtime-notifier-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { Store } from '../../persistence/loading-store/store'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'

export type OwnerRelay = { via: 'window' | 'desktop' | 'phone'; name: string }

export type OwnerWindowProbe = {
  /** Everything sent to the owner since the probe opened, in order. */
  readonly relays: OwnerRelay[]
  /** What the owner sees of the Home, byte for byte: its tab list, the saved layout and its sidebar record. */
  ownerState(): Promise<string>
  close(): void
}

/** Installs a window on `runtime` that records every call, and a desktop that records every send. */
export function ownerWindowProbe(
  runtime: OrcaRuntimeService,
  store: Store,
  home: string
): OwnerWindowProbe {
  const relays: OwnerRelay[] = []
  const record = (via: OwnerRelay['via'], name: string) => relays.push({ via, name })
  // Every method a real window has, each a recorder; `then` stays unset so the window is no promise.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy answers every method name.
  const notifier = new Proxy({} as RuntimeNotifier, {
    get: (_target, name) =>
      typeof name === 'string' && name !== 'then'
        ? (..._args: unknown[]) => record('window', name)
        : undefined,
    has: (_target, name) => typeof name === 'string' && name !== 'then'
  })
  const previousSurface = getRuntimeDesktopSurface()
  const desktop: RuntimeDesktopSurface = {
    showNotification: () => (record('desktop', 'showNotification'), true),
    sendToRenderers: (channel) => record('desktop', `sendToRenderers:${channel}`),
    hasWindow: () => true,
    hasLiveRenderer: () => true,
    sendToWindow: (_windowId, channel) => (record('desktop', `sendToWindow:${channel}`), true),
    requestRenderer: (_windowId, request) => {
      record('desktop', `requestRenderer:${request.channel}`)
      return Promise.reject(new Error('the probe answers no renderer request'))
    },
    holdRendererPublication: () => (record('desktop', 'holdRendererPublication'), () => {})
  }
  runtime.setNotifier(notifier)
  setRuntimeDesktopSurface(desktop)
  const stopPhone = runtime.onNotificationDispatched((event) => record('phone', event.type))
  const scope = parseWorkspaceKey(home)
  return {
    relays,
    ownerState: async () =>
      JSON.stringify({
        tabs: await runtime.listMobileSessionTabs(home),
        saved: store.getWorkspaceSession('local'),
        // Its sidebar sort stamps and unread flag.
        record: scope?.type === 'folder' ? store.getFolderWorkspace(scope.folderWorkspaceId) : null
      }),
    close: () => {
      stopPhone()
      runtime.setNotifier(null)
      setRuntimeDesktopSurface(previousSurface)
    }
  }
}
