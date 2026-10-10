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
import {
  sameSafeAreaInsets,
  ZERO_SAFE_AREA_INSETS,
  type BridgeSafeAreaInsets
} from './bridge-safe-area-insets'

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
  /** How much of the WebView sits under a system bar, for a page that pads for them itself. */
  safeAreaInsets?: BridgeSafeAreaInsets
  /** The keyboard height native screens read on the shell's OS. */
  keyboardInset?: number
  /** What each of those patterns declared, so the page can tell a hop it may keep from one it
   *  must hand back. Omitted by a shell that has none, which leaves the page on its old rule. */
  pageRouteGrants?: readonly { pathname: string; grants: readonly string[] }[]
  /** What this session may do: the protocol's own grant plus what its route declared. */
  granted: readonly string[]
  /** The host the page is showing, minus the credential the bridge already carries for it. */
  host: BridgeInitHost
  /** The allowlisted keys as the app holds them right now. */
  storage: Readonly<Record<string, string>>
  /** The allowlisted keys whose app-side value is over the page's cap, so `storage` has none
   *  (ruling 33.6). The page refuses its own writes to these rather than replacing the device's.
   *  Absent and empty are the same answer: nothing of the app's was left out. */
  storageOversize?: readonly string[]
  /** The page draws the host sidebar: this session owns the whole host area on a wide layout. */
  ownsHostArea?: boolean
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
    // Omitted when zero, like `storageOversize`: the page reads absent as zeros.
    ...(args.safeAreaInsets === undefined ||
    sameSafeAreaInsets(args.safeAreaInsets, ZERO_SAFE_AREA_INSETS)
      ? {}
      : { safeAreaInsets: { ...args.safeAreaInsets } }),
    ...(args.keyboardInset === undefined || args.keyboardInset === 0
      ? {}
      : { keyboardInset: args.keyboardInset }),
    pageRoutes: [...args.pageRoutes],
    // Copied entry by entry for the reason the grants are: nothing the shell keeps may be
    // reachable through a frame it hands out.
    ...(args.pageRouteGrants === undefined
      ? {}
      : {
          pageRouteGrants: args.pageRouteGrants.map((entry) => ({
            pathname: entry.pathname,
            grants: [...entry.grants]
          }))
        }),
    host: args.host,
    // Copied for the same reason the grants are: the frame is serialized straight after, and what
    // the shell holds must not be reachable through what it hands out.
    storage: { ...args.storage },
    // Omitted when empty rather than sent as `[]`: a field nobody sent and a field sent empty are
    // the same answer, and every golden in the corpus was recorded without it.
    ...(args.storageOversize === undefined || args.storageOversize.length === 0
      ? {}
      : { storageOversize: [...args.storageOversize] }),
    // Omitted when false, so every recorded golden stays byte-identical.
    ...(args.ownsHostArea === true ? { ownsHostArea: true } : {})
  }
}
