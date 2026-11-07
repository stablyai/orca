import { BRIDGE_MAX_ROUTE_PARAM_CHARS } from '../mobile-web-shell/bridge/bridge-caps'
import { BRIDGE_OPEN_ROUTE_PARAM } from '../mobile-web-shell/bridge/bridge-route-update'

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

export type HostStackSetParamsAction = Readonly<{
  type: 'SET_PARAMS'
  target: string
  source: string
  payload: { params: Readonly<Record<string, string>> }
}>

export type HostStackRootNavigation = {
  addListener: (event: 'state', listener: () => void) => () => void
  dispatch: (
    action: HostStackReplaceAction | HostStackPushAction | HostStackSetParamsAction
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

export type HostStackNavigationController = Readonly<{
  cancel: () => void
  isActive: () => boolean
  retarget: (target: HostStackRouteTarget) => void
}>

export type PendingHostStackNavigation = Readonly<{
  hostId: string
  controller: HostStackNavigationController
}>

export const HOST_SESSION_ROUTE = '[hostId]/session/[worktreeId]'
const HOST_INDEX_ROUTE = '[hostId]/index'

// A session keeps its host's list beneath it so Back lands there; other targets take the list's place.
function opensOverHostList(target: HostStackRouteTarget): boolean {
  return target.name === HOST_SESSION_ROUTE
}

const SETTLED_NAVIGATION: HostStackNavigationController = {
  cancel: () => {},
  isActive: () => false,
  retarget: () => {}
}

export function hostStackHostRoute(hostId: string): HostStackHostRoute {
  return `/h/${encodeURIComponent(hostId)}`
}

export function hostStackRouteHref(target: HostStackRouteTarget): HostStackRouteHref {
  return { pathname: `/h/${target.name}`, params: target.params }
}

// The host screen hands this to its page (`open`), which resolves it through Expo's linking as an in-page tap would; null when it can't fit the param.
function sessionOpenHref(target: HostStackRouteTarget): string | null {
  const { hostId = '', worktreeId = '', ...query } = target.params
  const search = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const href = `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}${search === '' ? '' : `?${search}`}`
  return href.length <= BRIDGE_MAX_ROUTE_PARAM_CHARS ? href : null
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
    hostRoute?.name !== HOST_INDEX_ROUTE ||
    !hostRoute.key ||
    !hostParamMatches(hostRoute.params?.hostId, expectedHostId)
  ) {
    return null
  }
  return { key: hostState.key, routeKey: hostRoute.key }
}

// Pending until the pushed host route commits, so a second tap for this host folds into the first instead of pushing another document.
function pendingUntilHostRoute(navigation: HostStackRootNavigation): HostStackNavigationController {
  let active = true
  let unsubscribe = () => {}
  const stop = () => {
    if (active) {
      active = false
      unsubscribe()
    }
  }
  unsubscribe = navigation.addListener('state', () => {
    const state = navigation.getState()
    if (state && focusedHostRoute(state)) {
      stop()
    }
  })
  return { cancel: stop, isActive: () => active, retarget: () => {} }
}

// Mount the host first, then open the target after its stack commits; a cold nested push otherwise resolves to a blank index without hostId.
export function navigateToHostStackRoute(
  navigation: HostStackRootNavigation,
  router: HostStackRouter,
  hostId: string,
  target: HostStackRouteTarget,
  openInHostDocument = false
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
    return SETTLED_NAVIGATION
  }
  // The host screen opens the session inside its document when its cached page can, else pushes it as before.
  const href = openInHostDocument && opensOverHostList(target) ? sessionOpenHref(target) : null
  // useLocalSearchParams decodes every value once more, which would undo the target's own escapes.
  const open = href === null ? null : encodeURIComponent(href)
  const inThisHost = hostState?.key && hostParamMatches(focused?.params?.hostId, hostId)
  if (open !== null && inThisHost && focused?.key && focused.name === HOST_INDEX_ROUTE) {
    navigation.dispatch({
      type: 'SET_PARAMS',
      target: hostState.key,
      source: focused.key,
      payload: { params: { [BRIDGE_OPEN_ROUTE_PARAM]: open } }
    })
    return SETTLED_NAVIGATION
  }
  // Already inside this host: pushing the host route again would stack a second list.
  if (opensOverHostList(target) && inThisHost) {
    navigation.dispatch({ type: 'PUSH', target: hostState.key, payload: target })
    return SETTLED_NAVIGATION
  }
  if (open !== null) {
    router.push({ pathname: '/h/[hostId]', params: { hostId, [BRIDGE_OPEN_ROUTE_PARAM]: open } })
    return pendingUntilHostRoute(navigation)
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
    const overHostList = opensOverHostList(selectedTarget)
    const hostStack = hostContainer && mountedHostStack(hostContainer, hostId)
    if (!hostStack) {
      if (hostContainer && hostParamMatches(hostContainer.params?.hostId, hostId)) {
        dispose()
        const href = hostStackRouteHref(selectedTarget)
        if (overHostList) {
          router.push(href)
        } else {
          router.replace(href)
        }
      }
      return
    }
    dispose()
    navigation.dispatch(
      overHostList
        ? { type: 'PUSH', target: hostStack.key, payload: selectedTarget }
        : {
            type: 'REPLACE',
            target: hostStack.key,
            source: hostStack.routeKey,
            payload: selectedTarget
          }
    )
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
  target: HostStackRouteTarget,
  openInHostDocument = false
): PendingHostStackNavigation {
  if (current?.hostId === hostId && current.controller.isActive()) {
    current.controller.retarget(target)
    return current
  }
  current?.controller.cancel()
  return {
    hostId,
    controller: navigateToHostStackRoute(navigation, router, hostId, target, openInHostDocument)
  }
}
