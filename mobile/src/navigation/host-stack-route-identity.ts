import type {
  HostStackNavigationRoute,
  HostStackNavigationState,
  HostStackRouteTarget
} from './host-stack-navigation'

const SESSION_ROUTE_NAME = '[hostId]/session/[worktreeId]'

export type HostStackPopToAction = Readonly<{
  type: 'POP_TO'
  target: string
  source: string
  payload: Readonly<{ name: string; merge: true }>
}>

/** One navigator on the path from the root state down to a mounted route. */
type MountedRouteStep = Readonly<{
  navigatorKey: string
  routeKey: string
  routeName: string
  routeIndex: number
  focusedIndex: number
}>

// Why: identity decides which mounted screen a target *is*, so it never decodes —
// expo-router already decoded the segment on the way into navigation state, so
// decoding again would let a host literally named `a%2Fb` alias the one named `a/b`.
function routeIsTarget(route: HostStackNavigationRoute, target: HostStackRouteTarget): boolean {
  if (route.name !== target.name || !route.params) {
    return false
  }
  const params: Readonly<Record<string, unknown>> = route.params
  // Session query params also carry presentation and one-shot creation state; only
  // the execution host and worktree identify the mounted session and its input lease.
  if (target.name === SESSION_ROUTE_NAME) {
    return (
      typeof target.params.worktreeId === 'string' &&
      params.hostId === target.params.hostId &&
      params.worktreeId === target.params.worktreeId
    )
  }
  const targetEntries = Object.entries(target.params)
  return (
    Object.keys(params).length === targetEntries.length &&
    targetEntries.every(([key, value]) => params[key] === value)
  )
}

/** Depth-first over the WHOLE state tree, not the focused chain: a session screen
 *  sitting under Files — or under a whole `h` route the user has navigated away
 *  from — is still mounted, and pushing a second copy of it is the defect. Ascending
 *  order returns the earliest instance, so an already-duplicated stack collapses. */
function findMountedRoute(
  state: HostStackNavigationState,
  target: HostStackRouteTarget
): MountedRouteStep[] | null {
  const navigatorKey = state.key
  if (navigatorKey === undefined) {
    return null
  }
  for (const [routeIndex, route] of state.routes.entries()) {
    if (route.key === undefined) {
      continue
    }
    const step: MountedRouteStep = {
      navigatorKey,
      routeKey: route.key,
      routeName: route.name,
      routeIndex,
      focusedIndex: state.index
    }
    if (routeIsTarget(route, target)) {
      return [step]
    }
    const nested = route.state && findMountedRoute(route.state, target)
    if (nested) {
      return [step, ...nested]
    }
  }
  return null
}

/** The actions that make an already-mounted target the focused route without
 *  mounting a second copy of it. Empty when it is already focused end to end. */
export function hostStackConvergenceActions(
  state: HostStackNavigationState,
  target: HostStackRouteTarget
): HostStackPopToAction[] | null {
  const path = findMountedRoute(state, target)
  if (!path) {
    return null
  }
  // `source` pins the pop to this exact route key, so a same-named route elsewhere
  // in the stack cannot capture it; `merge` with no params leaves them untouched.
  return path
    .filter((step) => step.routeIndex !== step.focusedIndex)
    .map((step) => ({
      type: 'POP_TO' as const,
      target: step.navigatorKey,
      source: step.routeKey,
      payload: { name: step.routeName, merge: true as const }
    }))
}
