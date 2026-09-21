import type { ForegroundNudgeReason } from '../../transport/types'
import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage
} from './bridge-envelope'
import { readBridgeExternalLinkUrl } from './bridge-caps'
import {
  BRIDGE_HAPTICS_GRANT,
  BRIDGE_HAPTICS_NOTIFY,
  type BridgeHapticsKind
} from './bridge-haptics-notify'
import { captureBridgeError } from './bridge-error-capture'

/**
 * Everything the page posts and hears nothing back about.
 *
 * Six of the seven post through one guard, but only two reach its throw, and it is not the guard
 * `sendRequest` uses. A call before `init` is a mount-order bug and throws; a call after `close` is
 * an unmounting screen posting one more nudge on its way out, which the native clients answer
 * inertly rather than by throwing into a teardown path nobody wrote a catch for. Nothing here
 * returns a promise, so nothing here can be awaited into a rejection either.
 *
 * Only the two ungated notifies reach that throw. A grant is read off the session, so before `init`
 * there is no grant either and `navigate`, `navigate-back`, `externalLink`, `storage` and the
 * haptic answer false without asking: that is the same false they answer a shell that withheld the
 * grant, and every caller already handles it — `useRouteHandoff` pushes or goes back inside the
 * page instead, where a throw would take down a tap handler nobody wrapped.
 *
 * `notifyPageFault` reads the session instead of requiring it for a different reason: its one caller
 * is an error boundary, and a report that threw would replace the page's last word with an error
 * nobody catches.
 */
export type BridgeClientNotificationDeps = {
  /** False when the frame never left the page. */
  send: (frame: BridgeClientMessage) => boolean
  /** Throws when `init` has not landed. */
  requireSession: () => void
  isClosed: () => boolean
  /** What `init.grants.native` named. A grant the shell did not give is a frame it would refuse. */
  hasGrant: (name: string) => boolean
}

export type BridgeClientNotifications = {
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  notifyNavigate: (href: string) => boolean
  notifyNavigateBack: () => boolean
  notifyExternalLink: (url: string) => boolean
  notifyStorageWrite: (key: string, value: string | null) => boolean
  notifyHaptics: (kind: BridgeHapticsKind) => boolean
  notifyPageFault: (error: unknown) => boolean
}

export function createBridgeClientNotifications(
  deps: BridgeClientNotificationDeps
): BridgeClientNotifications {
  function post(frame: BridgeClientMessage): boolean {
    deps.requireSession()
    return deps.isClosed() ? false : deps.send(frame)
  }

  return {
    updateTerminalSubscriptionViewport: (terminal, viewport) => {
      post({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'terminalViewport',
        terminal,
        cols: viewport.cols,
        rows: viewport.rows
      })
    },
    notifyForeground: (reason) => {
      post({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'foreground',
        ...(reason === undefined ? {} : { reason })
      })
    },
    // The one that answers: `notify` is closed, so a shell that granted no `navigate` would refuse
    // the whole frame, and a tap handler needs to know that before it decides it has navigated.
    notifyNavigate: (href) =>
      deps.hasGrant('navigate') &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'navigate', href }),
    // The same grant, read under the same name: `navigate-back` is a verb of `navigate` and never a
    // grant of its own, so a shell that listed it and not `navigate` has granted nothing.
    notifyNavigateBack: () =>
      deps.hasGrant('navigate') &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }),
    // Checked here as well as at the frame, because the answer is what the caller reports: a page
    // that posted a refused URL would be told the frame left and show a tap that went nowhere.
    notifyExternalLink: (url) => {
      if (!deps.hasGrant(BRIDGE_EXTERNAL_LINK_GRANT)) {
        return false
      }
      // The parser's URL goes on the wire, never the caller's string: the two differ for anything
      // carrying a stripped tab or newline, and the shell would open what the parser read anyway.
      const target = readBridgeExternalLinkUrl(url)
      if (target === null) {
        return false
      }
      return post({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: BRIDGE_EXTERNAL_LINK_GRANT,
        url: target
      })
    },
    // The page's writes reach the app's own store, which is the only store it has: its `localStorage`
    // is off on Android and per-session on iOS, so a pin kept there would forget itself on remount.
    notifyStorageWrite: (key, value) =>
      deps.hasGrant('storage') &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'storage', key, value }),
    // The answer is returned and never logged: a warning per refused frame would be one per row of
    // a scrolling list, and a tap that did not buzz is every tap on every phone before this page.
    notifyHaptics: (kind) =>
      deps.hasGrant(BRIDGE_HAPTICS_GRANT) &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind }),
    notifyPageFault: (error) => {
      if (deps.isClosed() || !deps.hasGrant(BRIDGE_FAULT_GRANT)) {
        return false
      }
      return deps.send({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: captureBridgeError(error)
      })
    }
  }
}
