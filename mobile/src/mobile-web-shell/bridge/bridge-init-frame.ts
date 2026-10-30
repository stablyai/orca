import { BRIDGE_MAX_PENDING_REQUESTS, BRIDGE_MAX_SUBSCRIPTIONS } from './bridge-caps'
import { MOBILE_WEB_SHELL_GRANTS } from '../page-route-policy'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RPC_ENVELOPE_GRANT,
  type BridgeColorScheme,
  type BridgeConnectionSnapshot,
  type BridgeHostMessage,
  type BridgeInitHost,
  type BridgeInitRoute,
  type BridgeUiLocale
} from './bridge-envelope'
import {
  sameSafeAreaInsets,
  ZERO_SAFE_AREA_INSETS,
  type BridgeSafeAreaInsets
} from './bridge-safe-area-insets'

// Grant the intersection of implemented capabilities and route declarations, plus protocol fault. Use the same resolved list for init and enforcement; new names need no version bump.
export const BRIDGE_NATIVE_GRANTS: readonly string[] = [
  BRIDGE_FAULT_GRANT,
  BRIDGE_RPC_ENVELOPE_GRANT,
  ...MOBILE_WEB_SHELL_GRANTS
]

export function createBridgeInitFrame(args: {
  sessionId: string
  buildId: string
  connection: BridgeConnectionSnapshot
  route: BridgeInitRoute
  pageRoutes: readonly string[]
  safeAreaInsets?: BridgeSafeAreaInsets
  keyboardInset?: number
  colorScheme?: BridgeColorScheme
  uiLocale?: BridgeUiLocale
  // Omit absent manifest pairs so older routing behavior remains available.
  pageRouteGrants?: readonly { pathname: string; grants: readonly string[] }[]
  granted: readonly string[]
  host: BridgeInitHost
  storage: Readonly<Record<string, string>>
  // Withheld oversized storage keys reject page writes; absent/empty both mean no app value was excluded (ruling 33.6).
  storageOversize?: readonly string[]
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
      // Copy grants so the emitted frame cannot mutate the host’s enforcement list.
      native: [...args.granted]
    },
    route: args.route,
    ...(args.safeAreaInsets === undefined ||
    sameSafeAreaInsets(args.safeAreaInsets, ZERO_SAFE_AREA_INSETS)
      ? {}
      : { safeAreaInsets: { ...args.safeAreaInsets } }),
    ...(args.keyboardInset === undefined || args.keyboardInset === 0
      ? {}
      : { keyboardInset: args.keyboardInset }),
    // Omit dark: it is what pages assume when an older shell sends nothing.
    ...(args.colorScheme === 'light' ? { colorScheme: 'light' as const } : {}),
    // Sent even for English: an absent field lets the page fall back to the WebView's language.
    ...(args.uiLocale === undefined ? {} : { uiLocale: args.uiLocale }),
    pageRoutes: [...args.pageRoutes],
    // Copy entries so no frame retains access to the shell’s held route-grant objects.
    ...(args.pageRouteGrants === undefined
      ? {}
      : {
          pageRouteGrants: args.pageRouteGrants.map((entry) => ({
            pathname: entry.pathname,
            grants: [...entry.grants]
          }))
        }),
    host: args.host,
    // Copy storage too; held shell state must not be reachable through emitted frames.
    storage: { ...args.storage },
    // Omit empty additive fields to preserve previously recorded wire frames.
    ...(args.storageOversize === undefined || args.storageOversize.length === 0
      ? {}
      : { storageOversize: [...args.storageOversize] }),
    ...(args.ownsHostArea === true ? { ownsHostArea: true } : {})
  }
}
