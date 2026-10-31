import {
  EMPTY_PAGE_GEOMETRY,
  samePageGeometry,
  type BridgePageGeometry
} from './bridge-page-geometry'
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
import type { BridgeFoldDivision } from './bridge-fold-division'
import type { BridgeTerminalKeyRail } from './bridge-terminal-key'

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
  /** The fold splitting the page, in its px; null or absent when none does. */
  pageGeometry?: BridgePageGeometry
  foldDivision?: BridgeFoldDivision | null
  /** The keys the shell's rail shows beside the page; omitted while none does. */
  terminalKeyRail?: BridgeTerminalKeyRail
  colorScheme?: BridgeColorScheme
  uiLocale?: BridgeUiLocale
  // Omit absent manifest pairs so older routing behavior remains available.
  pageRouteGrants?: readonly { pathname: string; grants: readonly string[] }[]
  granted: readonly string[]
  host: BridgeInitHost
  storage: Readonly<Record<string, string>>
  refreshTerminalShortcuts?: boolean
  /** The allowlisted keys whose app-side value is over the page's cap, so `storage` has none
   *  (ruling 33.6). The page refuses its own writes to these rather than replacing the device's.
   *  Absent and empty are the same answer: nothing of the app's was left out. */
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
    ...(args.pageGeometry === undefined || samePageGeometry(args.pageGeometry, EMPTY_PAGE_GEOMETRY)
      ? {}
      : {
          pageGeometry: {
            ...args.pageGeometry,
            occlusions: args.pageGeometry.occlusions.map((rect) => ({ ...rect }))
          }
        }),
    ...(args.foldDivision === undefined || args.foldDivision === null
      ? {}
      : { foldDivision: { ...args.foldDivision } }),
    ...(args.refreshTerminalShortcuts ? { refreshTerminalShortcuts: true } : {}),
    ...(args.terminalKeyRail === undefined || args.terminalKeyRail.length === 0
      ? {}
      : { terminalKeyRail: [...args.terminalKeyRail] }),
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
