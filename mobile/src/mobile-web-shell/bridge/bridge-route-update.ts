import { BridgeInitRouteSchema, type BridgeInitRoute } from './bridge-init-route'
import { shellScreenRouteKey } from '../shell-screen-route'

// Reuse init for same-screen pane updates: it already carries route and is reread on every ready, avoiding a new shell-to-page opcode.

// The page clears a one-shot param only after applying it, naming the consumed value. A newer native tap survives the holder’s comparison (ruling 34).
// Track no delivery: after a refused post, the next document’s ready receives the latest held route.
export const BRIDGE_ROUTE_PARAM_CLEAR = 'route-param-clear'

// Close the clearable-param set so the page can consume only shell-provided requests, not edit arbitrary native route state.
export const BRIDGE_CLEARABLE_ROUTE_PARAMS = ['paneKey'] as const

export type BridgeClearableRouteParam = (typeof BRIDGE_CLEARABLE_ROUTE_PARAMS)[number]

// Share shellScreenRouteKey with remount identity; deduplicate routes on both sides because every ready republishes the held route.
export function bridgeRouteMoved(
  held: BridgeInitRoute | null,
  next: BridgeInitRoute | null
): boolean {
  if (held === null || next === null) {
    return held !== next
  }
  return shellScreenRouteKey(held) !== shellScreenRouteKey(next)
}

// Both hold/send advance the route for the next ready; only send posts now. Post handoff alone does not consume the one-shot param.
export type BridgeRouteUpdate =
  | { readonly kind: 'send'; readonly route: BridgeInitRoute }
  | { readonly kind: 'hold'; readonly route: BridgeInitRoute }
  | { readonly kind: 'refuse'; readonly issue: string }

// Validate against the page’s reader and shared route identity; another screen requires shell remount, never an in-place init.
export function readBridgeRouteUpdate(args: {
  held: BridgeInitRoute | null
  next: BridgeInitRoute
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
