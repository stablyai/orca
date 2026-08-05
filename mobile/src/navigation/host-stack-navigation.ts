export type HostStackNavigationState = Readonly<{
  key?: string
  index: number
  routes: readonly HostStackNavigationRoute[]
}>

export type HostStackNavigationRoute = Readonly<{
  key?: string
  name: string
  params?: Readonly<{ hostId?: unknown }>
  state?: HostStackNavigationState
}>

/** A screen inside app/h/_layout.tsx plus the params it needs, e.g.
 *  `{ name: '[hostId]/session/[worktreeId]', params: { hostId, worktreeId } }`. */
export type HostStackRouteTarget = Readonly<{
  name: string
  params: Readonly<Record<string, string>>
}>

export type HostStackReplaceAction = Readonly<{
  type: 'REPLACE'
  target: string
  source: string
  payload: HostStackRouteTarget
}>

export type HostStackRootNavigation = {
  addListener: (event: 'state', listener: () => void) => () => void
  dispatch: (action: HostStackReplaceAction) => void
  // Why: the root layout's navigator has no committed state until it hydrates, and a
  // notification tap can arm the transition before that first commit.
  getState: () => HostStackNavigationState | undefined
}

export type HostStackHostRoute = `/h/${string}`

export type HostStackRouter = {
  push: (route: HostStackHostRoute) => void
}

export type HostStackNavigationController = Readonly<{
  cancel: () => void
  isActive: () => boolean
  retarget: (target: HostStackRouteTarget) => void
}>

export type PendingHostStackNavigation = Readonly<{
  hostId: string
  controller: HostStackNavigationController
}>

export function hostStackHostRoute(hostId: string): HostStackHostRoute {
  return `/h/${encodeURIComponent(hostId)}`
}

// Why: the host is pushed as an encoded segment, so the committed route may hold
// either form — an id with `/`, `#`, or `%` must still match its own push.
function hostParamMatches(param: unknown, expectedHostId: string): boolean {
  if (typeof param !== 'string') {
    return false
  }
  if (param === expectedHostId) {
    return true
  }
  try {
    return decodeURIComponent(param) === expectedHostId
  } catch {
    return false // Lone `%` — not our encoding.
  }
}

/** The focused `h` route, however deep the caller's navigator sits above it: a screen
 *  inside the root stack sees it at the top, but app/_layout.tsx is itself a screen of
 *  Expo Router's internal navigator, so from there the root stack is one level down. */
function focusedHostRoute(state: HostStackNavigationState): HostStackNavigationRoute | null {
  let current: HostStackNavigationState | undefined = state
  while (current) {
    const route: HostStackNavigationRoute | undefined = current.routes[current.index]
    if (!route) {
      return null
    }
    if (route.name === 'h') {
      return route
    }
    current = route.state
  }
  return null
}

function mountedHostStack(
  hostContainer: HostStackNavigationRoute,
  expectedHostId: string
): { key: string; routeKey: string } | null {
  const hostState = hostContainer.state
  const hostRoute = hostState?.routes[hostState.index]
  if (
    !hostState?.key ||
    hostRoute?.name !== '[hostId]/index' ||
    !hostRoute.key ||
    !hostParamMatches(hostRoute.params?.hostId, expectedHostId)
  ) {
    return null
  }
  return { key: hostState.key, routeKey: hostRoute.key }
}

/** Opens a deep host route by mounting `/h/[hostId]` first and replacing it once
 *  its stack is committed. A cold push straight to a nested route resolves to the
 *  host index without the dynamic id, which lands on a blank host screen. */
export function navigateToHostStackRoute(
  navigation: HostStackRootNavigation,
  router: HostStackRouter,
  hostId: string,
  target: HostStackRouteTarget
): HostStackNavigationController {
  let active = true
  let hostRouteSeen = false
  let selectedTarget = target
  let unsubscribeState = () => {}
  const dispose = () => {
    if (!active) {
      return
    }
    active = false
    unsubscribeState()
  }

  // Why: cold Expo deep links resolve to index; target the route only after its HostStack exists.
  const onState = () => {
    if (!active) {
      return
    }
    const state = navigation.getState()
    if (!state) {
      return
    }
    const hostContainer = focusedHostRoute(state)
    if (hostContainer) {
      hostRouteSeen = true
    } else if (hostRouteSeen) {
      dispose()
      return
    }
    const hostStack = hostContainer && mountedHostStack(hostContainer, hostId)
    if (!hostStack) {
      return
    }
    dispose()
    navigation.dispatch({
      type: 'REPLACE',
      target: hostStack.key,
      source: hostStack.routeKey,
      payload: selectedTarget
    })
  }

  try {
    unsubscribeState = navigation.addListener('state', onState)
    router.push(hostStackHostRoute(hostId))
  } catch (error) {
    dispose()
    throw error
  }
  return {
    cancel: dispose,
    isActive: () => active,
    retarget: (nextTarget) => {
      if (active) {
        selectedTarget = nextTarget
      }
    }
  }
}

export function coordinateHostStackNavigation(
  current: PendingHostStackNavigation | null,
  navigation: HostStackRootNavigation,
  router: HostStackRouter,
  hostId: string,
  target: HostStackRouteTarget
): PendingHostStackNavigation {
  if (current?.hostId === hostId && current.controller.isActive()) {
    current.controller.retarget(target)
    return current
  }
  current?.controller.cancel()
  return {
    hostId,
    controller: navigateToHostStackRoute(navigation, router, hostId, target)
  }
}
