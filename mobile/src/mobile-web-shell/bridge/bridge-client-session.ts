import type {
  BridgeGrants,
  BridgeHostMessage,
  BridgeInitHost,
  BridgeInitRoute
} from './bridge-envelope'
import { ZERO_SAFE_AREA_INSETS, type BridgeSafeAreaInsets } from './bridge-safe-area-insets'

export type BridgeShellSession = {
  sessionId: string
  buildId: string
  grants: BridgeGrants
  route: BridgeInitRoute | null
  pageRoutes: readonly string[]
  // Null means an older shell supplied no grant pairs; distinguish that from a target needing no grants and retain the older handoff rule.
  pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[] | null
  safeAreaInsets: BridgeSafeAreaInsets
  keyboardInset: number
  host: BridgeInitHost | null
  storage: Readonly<Record<string, string>>
  // Oversize keys are withheld from storage and reject writes locally; older shells omit this additive field (ruling 33.6).
  storageOversize: readonly string[]
  ownsHostArea: boolean
}

// Normalize the wire’s absent route to one client-side shape; undefined and missing serialize identically.
export function readShellSession(
  message: Extract<BridgeHostMessage, { type: 'init' }>
): BridgeShellSession {
  return {
    sessionId: message.sessionId,
    buildId: message.buildId,
    grants: message.grants,
    route: message.route ?? null,
    pageRoutes: message.pageRoutes ?? [],
    pageRouteGrants: message.pageRouteGrants ?? null,
    safeAreaInsets: message.safeAreaInsets ?? ZERO_SAFE_AREA_INSETS,
    keyboardInset: message.keyboardInset ?? 0,
    host: message.host ?? null,
    storage: message.storage ?? {},
    storageOversize: message.storageOversize ?? [],
    ownsHostArea: message.ownsHostArea === true
  }
}
