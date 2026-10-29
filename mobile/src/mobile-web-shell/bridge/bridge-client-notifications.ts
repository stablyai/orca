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
import { BRIDGE_LIVENESS_PROBE_NOTIFY } from './bridge-liveness-probe-notify'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge-page-back'
import { BRIDGE_PAGE_LOCATION } from './bridge-page-location'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'

// Ungated calls before init expose mount-order bugs; calls after close stay inert for teardown compatibility. Gated calls return false when no session/grant exists.
// Fault reporting must never throw from its error-boundary caller; it reads the session without requiring one.
export type BridgeClientNotificationDeps = {
  send: (frame: BridgeClientMessage) => boolean
  requireSession: () => void
  isClosed: () => boolean
  hasGrant: (name: string) => boolean
}

export type BridgeClientNotifications = {
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  notifyNavigate: (href: string, replace?: boolean) => boolean
  notifyNavigateBack: () => boolean
  notifyExternalLink: (url: string) => boolean
  notifyStorageWrite: (key: string, value: string | null) => boolean
  notifyHaptics: (kind: BridgeHapticsKind) => boolean
  notifyLivenessProbe: () => void
  notifyPageFault: (error: unknown) => boolean
  notifyPagePainted: () => void
  notifyBackClaim: (claimed: boolean) => void
  notifyPageLocation: (href: string) => void
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
    // Check grants before reporting navigation accepted; the closed shell notify union would otherwise drop the frame.
    notifyNavigate: (href, replace = false) =>
      deps.hasGrant('navigate') &&
      post({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'navigate',
        href,
        ...(replace ? { replace: true } : {})
      }),
    // navigate-back uses the navigate grant; a same-named grant is not a capability this protocol declares.
    notifyNavigateBack: () =>
      deps.hasGrant('navigate') &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }),
    // Reject URL schemes before posting so false tells the caller its tap went nowhere.
    notifyExternalLink: (url) => {
      if (!deps.hasGrant(BRIDGE_EXTERNAL_LINK_GRANT)) {
        return false
      }
      // Send the normalized URL the parser checked; stripped controls can make it differ from caller text.
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
    // Use native app storage: Android disables page localStorage and iOS scopes it to the session, so page-local pins would vanish on remount.
    notifyStorageWrite: (key, value) =>
      deps.hasGrant('storage') &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'storage', key, value }),
    // Return haptic refusal without logging per-row warnings.
    notifyHaptics: (kind) =>
      deps.hasGrant(BRIDGE_HAPTICS_GRANT) &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind }),
    notifyLivenessProbe: () => {
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_LIVENESS_PROBE_NOTIFY })
    },
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
    },
    notifyPagePainted: () => {
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_PAGE_PAINTED })
    },
    notifyBackClaim: (claimed) => {
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed })
    },
    notifyPageLocation: (href) => {
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_PAGE_LOCATION, href })
    }
  }
}
