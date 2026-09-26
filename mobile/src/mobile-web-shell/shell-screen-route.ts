// From the module that declares it, not from the envelope that re-exports it: the envelope reaches
// this file through the page-to-shell union, so reading the schema back through it is a cycle —
// and one that resolves to `undefined` in the page bundle rather than failing to build.
import { BridgeInitRouteSchema, type BridgeInitRoute } from './bridge/bridge-init-route'

/**
 * The route to hand the shell, or nothing if the page could not be given it.
 *
 * `bridge-host.ts` parses the route against this same schema and drops it to `null` when it fails,
 * so a route that does not fit reaches the phone as an `init` naming no screen — and the page
 * answers that with "Update Orca to open this workspace", which is both wrong and worse than the
 * native screen sitting right behind the switch. Deciding here instead means the route stays
 * native, which is where every route starts.
 *
 * A file path is the reason the files routes needed it first. Paths are params, not segments, so
 * `/`, spaces and `..` are all fine; length is not bounded by anything the user cannot exceed,
 * and `BRIDGE_MAX_ROUTE_PARAM_CHARS` is 1024 while a Windows long path is not. The same call
 * also catches a `worktreeId` the segment rule refuses, which is the C1.8 class, and a host id
 * that encoding does not save — a `.` or `..` — which is why every switch asks it now.
 *
 * The schema itself is the predicate rather than a copy of its bounds: two spellings of one rule
 * drift, and the half that matters is the half the page reads. Here rather than in one domain
 * because three routes had grown their own copy of the call.
 */
export function shellScreenRoute(route: BridgeInitRoute): BridgeInitRoute | null {
  return BridgeInitRouteSchema.safeParse(route).success ? route : null
}

/**
 * The identity of a route as the page will experience it, which is what a shell screen keys on.
 *
 * The pathname is not enough. The page learns its route exactly once, from `init`, and writes it
 * into its own history before the first render; nothing later tells it the route moved. So a
 * same-path param change — another file in the same worktree, a different `name` — leaves the
 * shell and its bridge host mounted, the page still showing the file it was opened on, and the
 * host answering any later `init` with whatever route it now holds. Keying on the params as well
 * makes that change a remount, which is the only thing that hands the page a new route.
 *
 * Serialized the same way the page's own bootstrap serializes it, so two routes that would put the
 * same URL in the page's history are the same key. Deliberately not imported from there:
 * `shellRouteHref` lives in `page-bootstrap.ts`, which reaches the page's RPC client and its
 * document channel, and a native route file must not pull those into the app. The test pins the
 * two equal instead, which is the dependency this comment actually has.
 */
export function shellScreenRouteKey(route: BridgeInitRoute): string {
  const search = new URLSearchParams(route.params ?? {}).toString()
  return search === '' ? route.pathname : `${route.pathname}?${search}`
}
