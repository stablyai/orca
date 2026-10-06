import { BridgeInitRouteSchema, type BridgeInitRoute } from './bridge-init-route'
import { shellScreenRouteKey } from '../shell-screen-route'

/**
 * A notification tap for another pane of the session on screen rewrites one route param of a page
 * that is already mounted, and the shell has no push lane to deliver it on: `notify` runs
 * page-to-shell only, and a shell-to-page frame kind would need a capability of its own
 * (`bridge-audio-verbs.ts` refused one for raw PCM). `init` already carries `route`, is already
 * re-sent on every `ready` and is already re-read, so the pane request rides a second `init`.
 */

/**
 * The notify a page posts to erase a one-shot route param.
 *
 * The reader erases (ruling 34). A notification tap writes `paneKey` onto the native route, the
 * shell re-sends `init` for as long as it holds one, and the page — having applied the pane — asks
 * for it to be cleared, naming the value it applied. Nothing tracks delivery on either side, and
 * the shell learns nothing from a post: a frame the page received and then failed to handle is the
 * page's own failure, reported there, and a post is refused only when no document holds the view.
 * Every one of those is followed by a fresh document's `ready`, answered with the route the shell
 * holds then. A clear naming a pane the tap has already moved past is refused by the comparison
 * rather than by a sequence number.
 */
export const BRIDGE_ROUTE_PARAM_CLEAR = 'route-param-clear'

/**
 * The params a page may ask to have erased, closed on purpose: a page naming any param would be
 * editing the shell's route rather than spending a request the shell handed it.
 */
export const BRIDGE_CLEARABLE_ROUTE_PARAMS = ['paneKey'] as const

export type BridgeClearableRouteParam = (typeof BRIDGE_CLEARABLE_ROUTE_PARAMS)[number]

/**
 * Whether two routes are different screens as the page experiences them.
 *
 * `shellScreenRouteKey` is the page's own identity for a route, so "moved" means here exactly what
 * a remount means at the switch, and both ends of the seam read the same definition: the host will
 * not send an `init` for a route that did not move, and the page will not publish one it was sent
 * anyway. The second half is not redundant — the shell answers every `ready`, including the ones
 * the page's own backoff and its stale-`state` restart ask for, and each of those carries the held
 * route.
 */
export function bridgeRouteMoved(
  held: BridgeInitRoute | null,
  next: BridgeInitRoute | null
): boolean {
  if (held === null || next === null) {
    return held !== next
  }
  return shellScreenRouteKey(held) !== shellScreenRouteKey(next)
}

/**
 * What a host does with a rewritten route: hold it for the next `init`, send one now, or refuse.
 *
 * `hold` and `send` both move what the host will publish, because a page that reloads inside this
 * mount must be handed the newest route on its next `ready`. Only `send` is a frame, and only a
 * frame lets the caller clear the param it delivered.
 */
export type BridgeRouteUpdate =
  | { readonly kind: 'send'; readonly route: BridgeInitRoute }
  | { readonly kind: 'hold'; readonly route: BridgeInitRoute }
  | { readonly kind: 'refuse'; readonly issue: string }

/**
 * Whether this host may hand its page that route, decided from the route it is already serving.
 *
 * A different pathname is a different screen, which the shell remounts for; the schema is the
 * page's own reader, so a shape it would refuse never leaves. Movement is measured with
 * `shellScreenRouteKey` rather than a second spelling of it, so "moved" here means exactly what a
 * remount means at the switch.
 */
export function readBridgeRouteUpdate(args: {
  held: BridgeInitRoute | null
  next: BridgeInitRoute
  /** Whether this host has a served document that has already had an `init`. */
  deliverable: boolean
}): BridgeRouteUpdate {
  const { held } = args
  const parsed = BridgeInitRouteSchema.safeParse(args.next)
  if (held === null || !parsed.success) {
    return { kind: 'refuse', issue: held === null ? 'no-route' : 'unreadable-route' }
  }
  if (parsed.data.pathname !== held.pathname) {
    return { kind: 'refuse', issue: 'not-this-screen' }
  }
  const moved = bridgeRouteMoved(held, parsed.data)
  return { kind: moved && args.deliverable ? 'send' : 'hold', route: parsed.data }
}
