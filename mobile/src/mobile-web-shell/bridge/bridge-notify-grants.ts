import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  type BridgeClientMessage
} from './bridge-envelope'
import { BRIDGE_HAPTICS_GRANT, BRIDGE_HAPTICS_NOTIFY } from './bridge-haptics-notify'

/** Every `notify` name the envelope accepts, so the table below cannot be asked about another. */
export type BridgeNotifyName = Extract<BridgeClientMessage, { type: 'notify' }>['name']

/**
 * Which grant each `notify` name rides, and `null` for the ones that ride none.
 *
 * Total over the union on purpose. Keyed on `string`, a name with no row read as ungated and the
 * host acted on a frame it had never granted — a new member of the notify union was a silent hole
 * rather than a compile error. `Record<BridgeNotifyName, …>` makes the omission a TS2741 here.
 *
 * Name and grant are separate columns because they are not always the same word: `navigate-back` is
 * the second verb of `navigate`, so an app that implements navigation implements both and nothing
 * new enters `MOBILE_WEB_SHELL_GRANTS`. Keyed on the notify name alone it would be refused by every
 * shell that exists.
 *
 * `foreground` and `terminalViewport` are the protocol's own and ride no grant. The other five are
 * inert while every page is offered all of them, and load-bearing the moment a grant is per-route.
 *
 * Haptics is the second whose name is not its grant, and for a different reason from
 * `navigate-back`: every grant in this table is a token because a notify is not a verb, and the
 * dotted names in `MOBILE_WEB_SHELL_GRANTS` come from the verb table alone.
 */
const BRIDGE_NOTIFY_GRANTS: Readonly<Record<BridgeNotifyName, string | null>> = {
  foreground: null,
  terminalViewport: null,
  navigate: 'navigate',
  [BRIDGE_NAVIGATE_BACK_NOTIFY]: 'navigate',
  storage: 'storage',
  [BRIDGE_EXTERNAL_LINK_GRANT]: BRIDGE_EXTERNAL_LINK_GRANT,
  [BRIDGE_FAULT_GRANT]: BRIDGE_FAULT_GRANT,
  [BRIDGE_HAPTICS_NOTIFY]: BRIDGE_HAPTICS_GRANT
}

export type BridgeNotifyRefusal = 'before-ready' | 'ungranted'

/**
 * Two refusals, not one.
 *
 * A page that has not asked for a session has been told nothing, so it holds no grant and cannot
 * have been given one. A page that has been told a list can still post a name outside it, and a
 * host issuing a grant is worth nothing if it serves the name anyway.
 */
export function bridgeNotifyRefusal(args: {
  /** The envelope's own name, so a caller cannot ask about one the table has no row for. */
  name: BridgeNotifyName
  /** Whether this host has answered a `ready` yet, which is the only thing that issues grants. */
  initSent: boolean
  granted: readonly string[]
}): BridgeNotifyRefusal | null {
  if (!args.initSent) {
    return 'before-ready'
  }
  const grant = BRIDGE_NOTIFY_GRANTS[args.name]
  return grant !== null && !args.granted.includes(grant) ? 'ungranted' : null
}
