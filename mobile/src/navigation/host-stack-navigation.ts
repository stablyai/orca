export type HostStackNavigationState = Readonly<{
  key?: string
  // Why optional: a navigator that has not committed yet holds a partial state without one.
  index?: number
  routeNames?: readonly string[]
  routes: readonly HostStackNavigationRoute[]
}>

export type HostStackNavigationRoute = Readonly<{
  key?: string
  name: string
  params?: Readonly<{ hostId?: unknown; worktreeId?: unknown }>
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

export type HostStackResetAction = Readonly<{
  type: 'RESET'
  target: string
  payload: Readonly<{ index: number; routes: readonly HostStackNavigationRoute[] }>
}>

export type HostStackRootNavigation = {
  addListener: (event: 'state', listener: () => void) => () => void
  dispatch: (
    action:
      | HostStackReplaceAction
      | HostStackResetAction
      | Readonly<{
          type: 'SET_PARAMS'
          target: string
          source: string
          payload: { params: Readonly<Record<string, string>> }
        }>
  ) => void
  // Why: the root layout's navigator has no committed state until it hydrates, and a
  // notification tap can arm the transition before that first commit.
  getState: () => HostStackNavigationState | undefined
}

export type HostStackHostRoute = `/h/${string}`

export type HostStackRouteHref = Readonly<{
  pathname: `/h/${string}`
  params: Readonly<Record<string, string>>
}>

export type HostStackRouter = {
  push: (route: HostStackHostRoute) => void
  replace: (route: HostStackRouteHref) => void
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

export function hostStackRouteHref(target: HostStackRouteTarget): HostStackRouteHref {
  return { pathname: `/h/${target.name}`, params: target.params }
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

function focusedRoute(state: HostStackNavigationState): HostStackNavigationRoute | undefined {
  return state.index === undefined ? undefined : state.routes[state.index]
}

/** The focused `h` route, however deep the caller's navigator sits above it: a screen
 *  inside the root stack sees it at the top, but app/_layout.tsx is itself a screen of
 *  Expo Router's internal navigator, so from there the root stack is one level down. */
function focusedHostRoute(state: HostStackNavigationState): HostStackNavigationRoute | null {
  let current: HostStackNavigationState | undefined = state
  while (current) {
    const route = focusedRoute(current)
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
  const hostRoute = hostState && focusedRoute(hostState)
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

/** Updates the target in place when it is already the focused host route (#20310). */
function updateFocusedTarget(
  navigation: HostStackRootNavigation,
  hostId: string,
  target: HostStackRouteTarget
): boolean {
  const state = navigation.getState()
  const hostState = state && focusedHostRoute(state)?.state
  const focused = hostState && focusedRoute(hostState)
  if (
    hostState?.key &&
    focused?.key &&
    focused.name === target.name &&
    hostParamMatches(focused.params?.hostId, hostId) &&
    hostParamMatches(focused.params?.worktreeId, target.params.worktreeId)
  ) {
    navigation.dispatch({
      type: 'SET_PARAMS',
      target: hostState.key,
      source: focused.key,
      payload: { params: target.params }
    })
    return true
  }
  return false
}

const SETTLED_NAVIGATION: HostStackNavigationController = {
  cancel: () => {},
  isActive: () => false,
  retarget: () => {}
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
  if (updateFocusedTarget(navigation, hostId, target)) {
    return SETTLED_NAVIGATION
  }

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
      if (hostContainer && hostParamMatches(hostContainer.params?.hostId, hostId)) {
        dispose()
        router.replace(hostStackRouteHref(selectedTarget))
      }
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

type CommittedRootStack = HostStackNavigationState & Readonly<{ key: string }>

function isCommittedRootStack(state: HostStackNavigationState): state is CommittedRootStack {
  return Boolean(state.key) && state.routeNames?.includes('h') === true
}

function committedRootStack(
  state: HostStackNavigationState | undefined
): CommittedRootStack | null {
  let current = state
  while (current) {
    if (isCommittedRootStack(current)) {
      return current
    }
    current = focusedRoute(current)?.state
  }
  return null
}

/** Reuses the first host area, its params and the host's list, so none of them remounts. */
export function workspaceLanding(
  root: CommittedRootStack,
  hostId: string,
  target: HostStackRouteTarget
): HostStackResetAction {
  const firstArea = root.routes.findIndex((route) => route.name === 'h')
  const below = firstArea === -1 ? root.routes : root.routes.slice(0, firstArea)
  const area = root.routes[below.length]
  const list = area?.state?.routes.find(
    (route) => route.name === '[hostId]/index' && hostParamMatches(route.params?.hostId, hostId)
  ) ?? { name: '[hostId]/index', params: { hostId } }
  return {
    type: 'RESET',
    target: root.key,
    payload: {
      index: below.length,
      routes: [
        ...below,
        { ...(area ?? { name: 'h' }), state: { index: 1, routes: [list, target] } }
      ]
    }
  }
}

/** Lands a push-opened workspace with only its host's workspace list beneath it. */
export function landOnWorkspace(
  navigation: HostStackRootNavigation,
  hostId: string,
  target: HostStackRouteTarget
): HostStackNavigationController {
  if (updateFocusedTarget(navigation, hostId, target)) {
    return SETTLED_NAVIGATION
  }
  let active = true
  let unsubscribe = () => {}
  const land = (): void => {
    const root = active ? committedRootStack(navigation.getState()) : null
    if (!root) {
      return
    }
    active = false
    unsubscribe()
    navigation.dispatch(workspaceLanding(root, hostId, target))
  }
  // Why: a cold-start tap arrives before the root stack has committed any state.
  unsubscribe = navigation.addListener('state', land)
  land()
  return {
    cancel: () => {
      active = false
      unsubscribe()
    },
    isActive: () => active,
    retarget: () => {}
  }
}
