import { readBridgeExternalLinkUrl } from './bridge/bridge-caps'
import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  type BridgeClientMessage,
  type BridgeInitRoute
} from './bridge/bridge-envelope'
import { BRIDGE_HAPTICS_NOTIFY } from './bridge/bridge-haptics-notify'
import { bridgeNotifyRefusal } from './bridge/bridge-notify-grants'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge/bridge-page-back'
import { BRIDGE_PAGE_LOCATION } from './bridge/bridge-page-location'
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import { BRIDGE_ROUTE_PARAM_CLEAR } from './bridge/bridge-route-update'
import type { BridgeHostOptions } from './bridge-host-contract'
import { pageMayWriteStorageKey } from './page-storage-keys'

type NotifyMessage = Extract<BridgeClientMessage, { type: 'notify' }>

// One-way frames owe no reply (ruling 34); catch downstream throws before they escape native dispatch and report once per session.
export function createBridgeNotifyForwarder(args: {
  options: BridgeHostOptions
  granted: readonly string[]
  initSent: () => boolean
  route: () => BridgeInitRoute | null
  onBackClaim: (claimed: boolean) => void
}): (message: NotifyMessage) => void {
  const { options, granted } = args
  const { client, host } = options
  let failureReported = false

  function act(message: NotifyMessage): void {
    if (message.name === BRIDGE_FAULT_GRANT) {
      options.onPageFault(message.error)
      return
    }
    if (message.name === BRIDGE_PAGE_PAINTED) {
      options.onPagePainted()
      return
    }
    if (message.name === BRIDGE_PAGE_LOCATION) {
      options.onPageLocation(message.href)
      return
    }
    if (message.name === BRIDGE_BACK_CLAIM_NOTIFY) {
      // Forward Back claims to the screen that owns the native key; this host serves only its document.
      args.onBackClaim(message.claimed)
      return
    }
    if (message.name === 'foreground') {
      if (message.reason === undefined) {
        client.notifyForeground()
      } else {
        client.notifyForeground(message.reason)
      }
      return
    }
    if (message.name === 'navigate') {
      options.onNavigate(message.href, message.replace === true)
      return
    }
    if (message.name === BRIDGE_NAVIGATE_BACK_NOTIFY) {
      // Report native Back refusal locally; no reply can tell the page its button did nothing.
      const outcome = options.onNavigateBack()
      if (outcome !== 'popped') {
        options.onDiagnostic?.({ kind: 'navigate-back-refused', why: outcome })
      }
      return
    }
    if (message.name === BRIDGE_EXTERNAL_LINK_GRANT) {
      // Pass the same normalized URL the envelope checked to the device handler; raw spelling could otherwise differ from the parsed target. Both use the same rule, so null is unreachable.
      const target = readBridgeExternalLinkUrl(message.url)
      if (target !== null) {
        options.onExternalLink(target)
      }
      return
    }
    if (message.name === 'storage') {
      // Check this session’s handed-over keys, not just the envelope’s key shape; valid orca:pins keys may name another host.
      // Enforce storageOversize here too: older pages ignore it and could overwrite retained device state (ruling 33.6).
      const held = options.readStorage()
      if (
        !pageMayWriteStorageKey(
          message.key,
          host.id,
          args.route(),
          held,
          options.ownsHostArea === true
        )
      ) {
        options.onDiagnostic?.({ kind: 'storage-refused', key: message.key })
        return
      }
      options.onStorageWrite(message.key, message.value)
      return
    }
    if (message.name === BRIDGE_HAPTICS_NOTIFY) {
      // Haptics are one-way so each row tap avoids spending a request slot.
      options.onHaptic(message.kind)
      return
    }
    if (message.name === BRIDGE_ROUTE_PARAM_CLEAR) {
      // The native route holder compares before clearing a consumed param; this host only forwards key/value (ruling 34).
      options.onRouteParamClear(message.param, message.value)
      return
    }
    client.updateTerminalSubscriptionViewport(message.terminal, {
      cols: message.cols,
      rows: message.rows
    })
  }

  return (message) => {
    const refusal = bridgeNotifyRefusal({
      name: message.name,
      initSent: args.initSent(),
      granted
    })
    if (refusal !== null) {
      options.onDiagnostic?.({ kind: 'notify-refused', name: message.name, why: refusal })
      return
    }
    try {
      act(message)
    } catch (error) {
      if (failureReported) {
        return
      }
      failureReported = true
      options.onDiagnostic?.({ kind: 'notify-failed', error })
    }
  }
}
