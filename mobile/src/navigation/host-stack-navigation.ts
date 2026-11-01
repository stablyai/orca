export type HostStackNavigationState = Readonly<{
  key?: string
  index: number
  routes: readonly HostStackNavigationRoute[]
}>

export type HostStackNavigationRoute = Readonly<{
  key?: string
  name: string
  params?: Readonly<{ hostId?: unknown; worktreeId?: unknown }>
  state?: HostStackNavigationState
}>

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

export type HostStackPushAction = Readonly<{
  type: 'PUSH'
  target: string
  payload: HostStackRouteTarget
}>

export type HostStackRootNavigation = {
  addListener: (event: 'state', listener: () => void) => () => void
  dispatch: (
    action:
      | HostStackReplaceAction
      | HostStackPushAction
      | Readonly<{
          type: 'SET_PARAMS'
          target: string
          source: string
          payload: { params: Readonly<Record<string, string>> }
        }>
  ) => void
  // Wait for hydration: notification taps can arrive before the root navigator has committed state.
  getState: () => HostStackNavigationState | undefined
}

export type HostStackHostRoute = `/h/${string}`

export type HostStackRouteHref = Readonly<{
  pathname: `/h/${string}`
  params: Readonly<Record<string, string>>
}>

export type HostStackRouter = {
  push: (route: HostStackHostRoute | HostStackRouteHref) => void
  replace: (route: HostStackRouteHref) => void
}

const HOST_INDEX_SCREEN = '[hostId]/index'
const HOST_SESSION_SCREEN = '[hostId]/session/[worktreeId]'

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

// Match decoded and encoded ids so slash/hash/percent host ids recognize their own push.
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
    return false
  }
}

// Find the focused h route through Expo’s internal root navigator as well as callers already inside the root stack.
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
    hostRoute?.name !== HOST_INDEX_SCREEN ||
    !hostRoute.key ||
    !hostParamMatches(hostRoute.params?.hostId, expectedHostId)
  ) {
    return null
  }
  return { key: hostState.key, routeKey: hostRoute.key }
}

function isHostSessionTarget(target: HostStackRouteTarget): boolean {
  return target.name === HOST_SESSION_SCREEN
}

function openCommittedHostTarget(
  navigation: HostStackRootNavigation,
  hostStack: { key: string; routeKey: string },
  target: HostStackRouteTarget
): void {
  // Leave the host list under a session so Back returns to it. Other screens still replace that list.
  if (isHostSessionTarget(target)) {
    navigation.dispatch({ type: 'PUSH', target: hostStack.key, payload: target })
    return
  }
  navigation.dispatch({
    type: 'REPLACE',
    target: hostStack.key,
    source: hostStack.routeKey,
    payload: target
  })
}

// Mount the host first, then open the target after its stack commits. A cold nested push otherwise resolves to a blank index without hostId.
export function navigateToHostStackRoute(
  navigation: HostStackRootNavigation,
  router: HostStackRouter,
  hostId: string,
  target: HostStackRouteTarget
): HostStackNavigationController {
  const state = navigation.getState()
  const hostState = state && focusedHostRoute(state)?.state
  const focused = hostState?.routes[hostState.index]
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
    return { cancel: () => {}, isActive: () => false, retarget: () => {} }
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
        const href = hostStackRouteHref(selectedTarget)
        if (isHostSessionTarget(selectedTarget)) {
          router.push(href)
        } else {
          router.replace(href)
        }
      }
      return
    }
    dispose()
    openCommittedHostTarget(navigation, hostStack, selectedTarget)
  }

  try {
    unsubscribeState = navigation.addListener('state', onState)
    // A host list that is already mounted may not emit state for another push of the same host.
    onState()
    if (active) {
      router.push(hostStackHostRoute(hostId))
    }
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

function levelContainsHostSession(level: HostStackNavigationState, hostId: string): boolean {
  return level.routes.some(
    (route) => route.name === HOST_SESSION_SCREEN && hostParamMatches(route.params?.hostId, hostId)
  )
}

// Prefer the focused host's nested stack. A screen already inside that stack sees the session directly.
export function sessionHostStackLevel(
  state: HostStackNavigationState,
  hostId: string
): HostStackNavigationState | null {
  const nested = focusedHostRoute(state)?.state
  if (nested && levelContainsHostSession(nested, hostId)) {
    return nested
  }
  if (levelContainsHostSession(state, hostId)) {
    return state
  }
  return null
}

// Insert the host list immediately before its session. Null when that list is already underneath.
export function withHostSessionListBeneath(
  level: HostStackNavigationState,
  hostId: string
): { index: number; routes: HostStackNavigationRoute[] } | null {
  let sessionIndex = -1
  for (let index = level.index; index >= 0; index -= 1) {
    const route = level.routes[index]
    if (route?.name === HOST_SESSION_SCREEN && hostParamMatches(route.params?.hostId, hostId)) {
      sessionIndex = index
      break
    }
  }
  if (sessionIndex < 0) {
    return null
  }
  for (let index = 0; index < sessionIndex; index += 1) {
    const route = level.routes[index]
    if (route?.name === HOST_INDEX_SCREEN && hostParamMatches(route.params?.hostId, hostId)) {
      return null
    }
  }
  const sessionHostId = level.routes[sessionIndex]?.params?.hostId
  const routes = [
    ...level.routes.slice(0, sessionIndex),
    {
      key: `host-session-list:${hostId}`,
      name: HOST_INDEX_SCREEN,
      params: { hostId: typeof sessionHostId === 'string' ? sessionHostId : hostId }
    },
    ...level.routes.slice(sessionIndex)
  ]
  return { index: level.index >= sessionIndex ? level.index + 1 : level.index, routes }
}
