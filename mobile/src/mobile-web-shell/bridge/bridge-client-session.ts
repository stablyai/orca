import type {
  BridgeColorScheme,
  BridgeGrants,
  BridgeHostMessage,
  BridgeInitHost,
  BridgeInitRoute,
  BridgeUiLocale
} from './bridge-envelope'
import { ZERO_SAFE_AREA_INSETS, type BridgeSafeAreaInsets } from './bridge-safe-area-insets'
import { EMPTY_PAGE_GEOMETRY, type BridgePageGeometry } from './bridge-page-geometry'
import type { BridgeFoldDivision } from './bridge-fold-division'
import type { BridgeTerminalKeyRail } from './bridge-terminal-key'

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
  /** The fold splitting the page on a partially folded device; null when none does, which is
   *  every device that does not fold and every shell before the field. */
  pageGeometry: BridgePageGeometry
  foldDivision: BridgeFoldDivision | null
  /** The keys the shell's rail shows beside this page; empty for every shell before the field. */
  terminalKeyRail: BridgeTerminalKeyRail
  // Null means an older shell sent no language; the page then follows the WebView's languages.
  uiLocale: BridgeUiLocale | null
  /** Null for a shell too old to name it; the page's own `loadHosts()` then answers with nothing. */
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
    pageGeometry: message.pageGeometry ?? EMPTY_PAGE_GEOMETRY,
    foldDivision: message.foldDivision ?? null,
    terminalKeyRail: message.terminalKeyRail ?? [],
    colorScheme: message.colorScheme ?? 'dark',
    uiLocale: message.uiLocale ?? null,
    host: message.host ?? null,
    storage: message.storage ?? {},
    storageOversize: message.storageOversize ?? [],
    ownsHostArea: message.ownsHostArea === true
  }
}
