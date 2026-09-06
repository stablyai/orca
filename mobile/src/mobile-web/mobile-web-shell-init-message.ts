import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  MOBILE_WEB_SHELL_FEATURES,
  type MobileWebBridgeShellMessage,
  type MobileWebResumeRoute
} from '../../../src/shared/mobile-web/bridge-contract'
import type { ConnectionState } from '../transport/types'
import { mobileWebBridgeConnectionState } from './mobile-web-bridge-connection-state'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

type MobileWebShellInitArgs = {
  shellSessionId: string
  buildId: string
  state: ConnectionState
  hostDisplayName: string | undefined
  reconnectAttempts: number
  lastConnectedAt: number | null
  resumeRoute: MobileWebResumeRoute | undefined
}

// Why: the init envelope is the one place the shell declares its grants and features to a page,
// so it is built here rather than inline in the route screen.
export function mobileWebShellInitMessage(
  args: MobileWebShellInitArgs
): Extract<MobileWebBridgeShellMessage, { type: 'init' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'init',
    shellSessionId: args.shellSessionId,
    buildId: args.buildId,
    connection: mobileWebBridgeConnectionState(args.state),
    hostDisplayName: args.hostDisplayName,
    reconnectAttempts: args.reconnectAttempts,
    lastConnectedAt: args.lastConnectedAt,
    resumeRoute: args.resumeRoute,
    grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
    shellFeatures: [...MOBILE_WEB_SHELL_FEATURES]
  }
}
