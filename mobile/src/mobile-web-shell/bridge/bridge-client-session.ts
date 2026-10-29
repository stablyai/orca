import type {
  BridgeColorScheme,
  BridgeGrants,
  BridgeHostMessage,
  BridgeInitHost,
  BridgeInitRoute,
  BridgeUiLocale
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
  // Older shells omit this and paint dark native chrome, so absent means dark.
  colorScheme: BridgeColorScheme
  // Null means an older shell sent no language; the page then follows the WebView's languages.
  uiLocale: BridgeUiLocale | null
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
    colorScheme: message.colorScheme ?? 'dark',
    uiLocale: message.uiLocale ?? null,
    host: message.host ?? null,
    storage: message.storage ?? {},
    storageOversize: message.storageOversize ?? [],
    ownsHostArea: message.ownsHostArea === true
  }
}
