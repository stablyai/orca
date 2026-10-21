/** The host stack's focused index, read off the root stack's `h` route; 0 before it has one. */
function hostStackFocusedIndex(state: unknown): number {
  if (typeof state !== 'object' || state === null) {
    return 0
  }
  if ('index' in state && typeof state.index === 'number') {
    return state.index
  }
  // Why: a partial state (deep link before the stack mounts) may omit `index`; last route is focused.
  if ('routes' in state && Array.isArray(state.routes)) {
    return state.routes.length - 1
  }
  return 0
}

/** The root stack's `h` route as its options callback receives it; `state` is the host stack's. */
export type RootHostGroupRoute = Readonly<{ key: string; name: string; state?: unknown }>

/**
 * Whether the root stack may arm its iOS edge swipe on the `h` screen.
 *
 * The host routes are a native stack nested inside the root one, and both arm an edge-swipe pop.
 * With a screen pushed inside the host stack (files over the session, say) the root's swipe can
 * win and pop the whole host group to Home, while the chevron's `router.back()` correctly pops one
 * host screen. So the root owns the swipe only while the host stack is on its first screen.
 */
export function rootOwnsHostGroupBackGesture(route: RootHostGroupRoute): boolean {
  return hostStackFocusedIndex(route.state) <= 0
}
