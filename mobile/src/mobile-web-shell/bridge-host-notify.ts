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
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import { BRIDGE_ROUTE_PARAM_CLEAR } from './bridge/bridge-route-update'
import type { BridgeHostOptions } from './bridge-host-contract'
import { pageMayWriteStorageKey } from './page-storage-keys'

type NotifyMessage = Extract<BridgeClientMessage, { type: 'notify' }>

/**
 * Where every one-way page frame is spent, split out of `bridge-host.ts` because that file sits at
 * its line cap and this is the half of it that grows: each new notify is a branch here and a row in
 * `bridge-notify-grants.ts`.
 *
 * Nothing is owed back on any of them (ruling 34). The client's own work runs inside these calls,
 * so a throw from one would otherwise escape into the native event handler that delivered the
 * frame; it is caught once per session and reported, because a page nudging a broken listener
 * nudges it again on every foreground.
 */
export function createBridgeNotifyForwarder(args: {
  options: BridgeHostOptions
  /** This session's whole capability: the protocol's own grant plus what its route declared. */
  granted: readonly string[]
  /** Whether this host has answered a `ready`, which is the only thing that issues grants. */
  initSent: () => boolean
  /** The screen this host is serving, which decides which storage keys the page may write. */
  route: () => BridgeInitRoute | null
  onBackClaim: (claimed: boolean) => void
}): (message: NotifyMessage) => void {
  const { options, granted } = args
  const { client, host } = options
  let failureReported = false

  function act(message: NotifyMessage): void {
    if (message.name === BRIDGE_FAULT_GRANT) {
      // Not the client's: a page that threw is this session's problem, and the desktop on the
      // other end of the client has nothing to do with it.
      options.onPageFault(message.error)
      return
    }
    if (message.name === BRIDGE_PAGE_PAINTED) {
      // Local, like `navigate`: nothing about the page's own frame reaches the desktop.
      options.onPagePainted()
      return
    }
    if (message.name === BRIDGE_BACK_CLAIM_NOTIFY) {
      // Local, and the one notify that changes what a device key does. Carried up rather than
      // acted on here: the key belongs to the screen, and this host serves one document of it.
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
      // Not routed to the client: this one never leaves the phone. The page asked for a screen
      // it does not render, and the caller pushes it over the still-mounted view.
      options.onNavigate(message.href)
      return
    }
    if (message.name === BRIDGE_NAVIGATE_BACK_NOTIFY) {
      // Local too, and the one notify with no argument: the shell pops what it pushed. A pop the
      // shell did not make is reported rather than answered, because the page is told nothing
      // either way and a Back button that does nothing is what would otherwise go unnoticed.
      const outcome = options.onNavigateBack()
      if (outcome !== 'popped') {
        options.onDiagnostic?.({ kind: 'navigate-back-refused', why: outcome })
      }
      return
    }
    if (message.name === BRIDGE_EXTERNAL_LINK_GRANT) {
      // Local as well: this one leaves the app entirely rather than reaching the desktop. Read
      // rather than forwarded, because what the envelope accepted is the string and what it
      // accepted it for is the parser's URL — a page posting an unnormalized one would otherwise
      // hand the device handler something the check never looked at. Null cannot arrive here:
      // the envelope refines on the same rule, and the branch is what says so.
      const target = readBridgeExternalLinkUrl(message.url)
      if (target !== null) {
        options.onExternalLink(target)
      }
      return
    }
    if (message.name === 'storage') {
      // Also local, and held to this host's own keys. The envelope allowlists the shape before
      // this runs, which lets `orca:pins:<any host>` through: a page opened for one host must
      // not rewrite another's pinned list, and the keys it was handed are the ones it may write.
      // Three refusals in one, decided where the keys are (ruling 33.6): the oversize half has
      // to be enforced here because a page served from an older desktop bundle does not read
      // `storageOversize` and would write the key whole over what the device holds.
      const held = options.readStorage()
      if (!pageMayWriteStorageKey(message.key, host.id, args.route(), held)) {
        options.onDiagnostic?.({ kind: 'storage-refused', key: message.key })
        return
      }
      options.onStorageWrite(message.key, message.value)
      return
    }
    if (message.name === BRIDGE_HAPTICS_NOTIFY) {
      // Local, and the only notify the shell answers with hardware. Nothing crosses back, which
      // is the whole reason this is a notify: a reply would spend an in-flight slot per row tap.
      options.onHaptic(message.kind)
      return
    }
    if (message.name === BRIDGE_ROUTE_PARAM_CLEAR) {
      // Local, and the one frame that writes to the shell's own route (ruling 34). Carried up
      // rather than acted on here: the param lives on the native route the switch holds, and
      // whether this still names it is that holder's comparison to make.
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
