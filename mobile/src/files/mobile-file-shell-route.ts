import {
  BridgeInitRouteSchema,
  type BridgeInitRoute
} from '../mobile-web-shell/bridge/bridge-envelope'

/**
 * The route to hand the shell, or nothing if the page could not be given it.
 *
 * `bridge-host.ts` parses the route against this same schema and drops it to `null` when it fails,
 * so a route that does not fit reaches the phone as an `init` naming no screen — and the page
 * answers that with "Update Orca to open this workspace", which is both wrong and worse than the
 * native screen sitting right behind the switch. Deciding here instead means the route stays
 * native, which is where every route starts.
 *
 * A file path is the reason this domain needs it. Paths are params, not segments, so `/`, spaces
 * and `..` are all fine; length is not bounded by anything the user cannot exceed, and
 * `BRIDGE_MAX_ROUTE_PARAM_CHARS` is 1024 while a Windows long path is not. The same call also
 * catches a `worktreeId` the segment rule refuses, which is the C1.8 class.
 *
 * The schema itself is the predicate rather than a copy of its bounds: two spellings of one rule
 * drift, and the half that matters is the half the page reads. This belongs in the shell beside
 * that schema; it lives here while the contract files are the C2 lane's.
 */
export function mobileFileShellRoute(route: BridgeInitRoute): BridgeInitRoute | null {
  return BridgeInitRouteSchema.safeParse(route).success ? route : null
}
