import type { ForegroundNudgeReason } from '../../transport/types'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage
} from './bridge-envelope'
import { captureBridgeError } from './bridge-error-capture'

/**
 * Everything the page posts and hears nothing back about.
 *
 * Three of the four post through one guard, but only two reach its throw, and it is not the guard
 * `sendRequest` uses. A call before `init` is a mount-order bug and throws; a call after `close` is
 * an unmounting screen posting one more nudge on its way out, which the native clients answer
 * inertly rather than by throwing into a teardown path nobody wrote a catch for. Nothing here
 * returns a promise, so nothing here can be awaited into a rejection either.
 *
 * Only the two ungated notifies reach that throw. A grant is read off the session, so before `init`
 * there is no grant either and `navigate` and `storage` answer false without asking: that is the
 * same false they answer a shell that withheld the grant, and both callers already handle it —
 * `useRouteHandoff` pushes inside the page instead, where a throw would take down a tap handler
 * nobody wrapped.
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
  notifyStorageWrite: (key: string, value: string | null) => boolean
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
    // The page's writes reach the app's own store, which is the only store it has: its `localStorage`
    // is off on Android and per-session on iOS, so a pin kept there would forget itself on remount.
    notifyStorageWrite: (key, value) =>
      deps.hasGrant('storage') &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'storage', key, value }),
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
