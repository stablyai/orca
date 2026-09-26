import type {
  BridgeGrants,
  BridgeHostMessage,
  BridgeInitHost,
  BridgeInitRoute
} from './bridge-envelope'
import { ZERO_SAFE_AREA_INSETS, type BridgeSafeAreaInsets } from './bridge-safe-area-insets'

/** What `init` said this page is attached to. `grants` is what a call site checks before it posts. */
export type BridgeShellSession = {
  sessionId: string
  buildId: string
  grants: BridgeGrants
  /** Null for a shell too old to name one. The page has no other way to know which screen to open. */
  route: BridgeInitRoute | null
  /** The route patterns this page may keep for itself. Empty for a shell that names none, which
   *  hands every navigation back and is what a shell with no `navigate` grant can honour. */
  pageRoutes: readonly string[]
  /**
   * What each of those patterns declared, when the shell said.
   *
   * `null` for a shell that sent none, which is the only thing that separates "this route needs
   * nothing" from "nobody told me". The handoff keeps its older rule on `null` and cannot invent a
   * coverage verdict out of an absent field.
   */
  pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[] | null
  /** How much of the WebView sits under a system bar. Zeros for a shell that reserves the bars
   *  outside the view, which is every shell before the field. */
  safeAreaInsets: BridgeSafeAreaInsets
  /** How much of the WebView the software keyboard covers. 0 for a shell that shortens the view
   *  above it instead, which is every shell before the field. */
  keyboardInset: number
  /** Null for a shell too old to name it; the page's own `loadHosts()` then answers with nothing. */
  host: BridgeInitHost | null
  /** The allowlisted keys as the app held them when this page opened. */
  storage: Readonly<Record<string, string>>
  /** The allowlisted keys `storage` could not carry because the app's value is over the page's cap
   *  (ruling 33.6). Empty for a shell too old to name them, which is what it was before. */
  storageOversize: readonly string[]
  /**
   * What this shell takes from the page beyond the frames every shell has taken (ruling 34).
   *
   * Empty for a shell that named none, which is every shell before this field: a page that posts
   * one of these to one of those has the whole frame refused as `unrecognised-message`, so the
   * check is the page's and it is made from here.
   */
  accepts: readonly string[]
}

/**
 * The session an `init` describes.
 *
 * `route` is absent on the wire rather than null, because a field written as `undefined` and a
 * field nobody sent are the same frame; the page reads one shape from here and never both.
 */
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
    accepts: message.accepts ?? []
  }
}
