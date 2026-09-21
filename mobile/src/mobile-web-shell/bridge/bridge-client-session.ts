import type {
  BridgeGrants,
  BridgeHostMessage,
  BridgeInitHost,
  BridgeInitRoute
} from './bridge-envelope'

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
  /** Null for a shell too old to name it; the page's own `loadHosts()` then answers with nothing. */
  host: BridgeInitHost | null
  /** The allowlisted keys as the app held them when this page opened. */
  storage: Readonly<Record<string, string>>
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
    host: message.host ?? null,
    storage: message.storage ?? {}
  }
}
