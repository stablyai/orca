import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  type BridgeClientMessage
} from './bridge-envelope'
import { BRIDGE_HAPTICS_GRANT, BRIDGE_HAPTICS_NOTIFY } from './bridge-haptics-notify'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge-page-back'
import { BRIDGE_PAGE_LOCATION } from './bridge-page-location'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'
import { BRIDGE_ROUTE_PARAM_CLEAR } from './bridge-route-update'

export type BridgeNotifyName = Extract<BridgeClientMessage, { type: 'notify' }>['name']

// Require a row for every notify name; a string-keyed table would let missing rows act as ungated capabilities.
// Names and grants differ: navigate-back uses navigate, while native.haptics.trigger uses haptics. Protocol-owned document reports remain ungated.
const BRIDGE_NOTIFY_GRANTS: Readonly<Record<BridgeNotifyName, string | null>> = {
  foreground: null,
  terminalViewport: null,
  [BRIDGE_ROUTE_PARAM_CLEAR]: null,
  [BRIDGE_PAGE_PAINTED]: null,
  [BRIDGE_BACK_CLAIM_NOTIFY]: null,
  [BRIDGE_PAGE_LOCATION]: null,
  navigate: 'navigate',
  [BRIDGE_NAVIGATE_BACK_NOTIFY]: 'navigate',
  storage: 'storage',
  [BRIDGE_EXTERNAL_LINK_GRANT]: BRIDGE_EXTERNAL_LINK_GRANT,
  [BRIDGE_FAULT_GRANT]: BRIDGE_FAULT_GRANT,
  [BRIDGE_HAPTICS_NOTIFY]: BRIDGE_HAPTICS_GRANT
}

export type BridgeNotifyRefusal = 'before-ready' | 'ungranted'

// Distinguish no established session from an established session lacking this grant; never serve either merely because a name is recognized.
export function bridgeNotifyRefusal(args: {
  name: BridgeNotifyName
  initSent: boolean
  granted: readonly string[]
}): BridgeNotifyRefusal | null {
  if (!args.initSent) {
    return 'before-ready'
  }
  const grant = BRIDGE_NOTIFY_GRANTS[args.name]
  return grant !== null && !args.granted.includes(grant) ? 'ungranted' : null
}
