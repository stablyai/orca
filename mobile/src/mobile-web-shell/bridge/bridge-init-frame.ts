import { BRIDGE_MAX_PENDING_REQUESTS, BRIDGE_MAX_SUBSCRIPTIONS } from './bridge-caps'
import { MOBILE_WEB_SHELL_GRANTS } from '../page-route-policy'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeConnectionSnapshot,
  type BridgeHostMessage,
  type BridgeInitHost,
  type BridgeInitRoute
} from './bridge-envelope'

/**
 * Every grant this app implements, which is the ceiling a session's own list is drawn from. A page
 * is granted the intersection of this and what its route declared, never this.
 *
 * What `init` offers a page.
 *
 * A name added here is never a version bump; a page that does not know one simply never posts it.
 * `fault` leads because it is the protocol's rather than a screen's: every page gets it and no
 * route declares it. The host enforces this same list, so what a page is told it may do and what it
 * will actually be served cannot drift.
 */
export const BRIDGE_NATIVE_GRANTS: readonly string[] = [
  BRIDGE_FAULT_GRANT,
  ...MOBILE_WEB_SHELL_GRANTS
]

/** The one frame that starts a session, built in one place so its caps and its grants agree. */
export function createBridgeInitFrame(args: {
  sessionId: string
  buildId: string
  connection: BridgeConnectionSnapshot
  /** The screen this page stands in for, which the document's own `/` cannot tell it. */
  route: BridgeInitRoute
  /** The route patterns the page keeps for itself; everything else comes back as `navigate`. */
  pageRoutes: readonly string[]
  /** What this session may do: the protocol's own grant plus what its route declared. */
  granted: readonly string[]
  /** The host the page is showing, minus the credential the bridge already carries for it. */
  host: BridgeInitHost
  /** The allowlisted keys as the app holds them right now. */
  storage: Readonly<Record<string, string>>
}): Extract<BridgeHostMessage, { type: 'init' }> {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'init',
    sessionId: args.sessionId,
    buildId: args.buildId,
    connection: args.connection,
    grants: {
      rpc: {
        maxPendingRequests: BRIDGE_MAX_PENDING_REQUESTS,
        maxSubscriptions: BRIDGE_MAX_SUBSCRIPTIONS
      },
      // Copied, not shared: the list the host enforces must not be reachable through a frame it
      // hands out.
      native: [...args.granted]
    },
    route: args.route,
    pageRoutes: [...args.pageRoutes],
    host: args.host,
    // Copied for the same reason the grants are: the frame is serialized straight after, and what
    // the shell holds must not be reachable through what it hands out.
    storage: { ...args.storage }
  }
}
