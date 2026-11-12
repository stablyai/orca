import { BRIDGE_MAX_ROUTE_PARAM_CHARS } from '../mobile-web-shell/bridge/bridge-caps'
import { BRIDGE_OPEN_ROUTE_PARAM } from '../mobile-web-shell/bridge/bridge-route-update'
import { focusedIndex } from '../mobile-web-shell/native-stack-return'

export type HostStackNavigationState = Readonly<{
  key?: string
  index?: number
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
  retarget: (target: HostStackRouteTarget, openInHostDocument: boolean) => void
}>

export type PendingHostStackNavigation = Readonly<{
  hostId: string
  controller: HostStackNavigationController
}>

export const HOST_SESSION_ROUTE = '[hostId]/session/[worktreeId]'
const HOST_INDEX_ROUTE = '[hostId]/index'

// A session opened in its host list's place (Home's agent rows), so Back leaves the host instead of showing the list.
export const STANDALONE_SESSION_PARAM = 'standalone'

export function isStandaloneSessionHref(href: string): boolean {
  const [path = '', query = ''] = (href.split('#')[0] ?? '').split('?')
  return (
    /^\/h\/[^/]+\/session\//.test(path) &&
    query.split('&').includes(`${STANDALONE_SESSION_PARAM}=1`)
  )
}

function isSessionRoute(target: HostStackRouteTarget): boolean {
  return target.name === HOST_SESSION_ROUTE
}

// A session keeps its host's list beneath it so Back lands there, unless it is standalone; other targets take the list's place.
function opensOverHostList(target: HostStackRouteTarget): boolean {
  return isSessionRoute(target) && target.params[STANDALONE_SESSION_PARAM] !== '1'
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

function focusedRouteOf(state: HostStackNavigationState): HostStackNavigationRoute | undefined {
  return state.routes[focusedIndex(state)]
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
    const route = focusedRouteOf(current)
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
  const hostRoute = hostState && focusedRouteOf(hostState)
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
  const focused = hostState && focusedRouteOf(hostState)
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
  // The host screen opens the session inside its document when the page it activates can, else pushes it as before.
  const href = openInHostDocument && isSessionRoute(target) ? sessionOpenHref(target) : null
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
  if (isSessionRoute(target) && inThisHost) {
    if (!opensOverHostList(target) && focused?.key && focused.name === HOST_INDEX_ROUTE) {
      navigation.dispatch({
        type: 'REPLACE',
        target: hostState.key,
        source: focused.key,
        payload: target
      })
    } else {
      navigation.dispatch({ type: 'PUSH', target: hostState.key, payload: target })
    }
    return SETTLED_NAVIGATION
  }
  return open === null
    ? openWhenHostStackCommits(
        navigation,
        router,
        hostId,
        () => router.push(hostStackHostRoute(hostId)),
        [target, openInHostDocument]
      )
    : openWhenHostStackCommits(navigation, router, hostId, () =>
        router.push({
          pathname: '/h/[hostId]',
          params: { hostId, [BRIDGE_OPEN_ROUTE_PARAM]: open }
        })
      )
}

// Push the host, then open the latest target on its stack once it commits; another tap for this host retargets instead of pushing a second document.
function openWhenHostStackCommits(
  navigation: HostStackRootNavigation,
  router: HostStackRouter,
  hostId: string,
  pushHost: () => void,
  first: [HostStackRouteTarget, boolean] | null = null
): HostStackNavigationController {
  let active = true
  let hostRouteSeen = false
  let latest = first
  let unsubscribe = () => {}
  const dispose = () => {
    if (active) {
      active = false
      unsubscribe()
    }
  }
  const onState = () => {
    const state = active ? navigation.getState() : undefined
    if (!state) {
      return
    }
    const hostContainer = focusedHostRoute(state)
    if (!hostContainer) {
      if (hostRouteSeen) {
        dispose()
      }
      return
    }
    hostRouteSeen = true
    const hostStack = mountedHostStack(hostContainer, hostId)
    if (!hostStack) {
      // Root state that omits the mounted child stack: let Expo Router resolve the target instead.
      if (hostParamMatches(hostContainer.params?.hostId, hostId)) {
        dispose()
        if (latest) {
          const href = hostStackRouteHref(latest[0])
          return void (opensOverHostList(latest[0]) ? router.push(href) : router.replace(href))
        }
      }
      return
    }
    dispose()
    if (latest && isSessionRoute(latest[0])) {
      navigateToHostStackRoute(navigation, router, hostId, ...latest)
    } else if (latest) {
      navigation.dispatch({
        type: 'REPLACE',
        target: hostStack.key,
        source: hostStack.routeKey,
        payload: latest[0]
      })
    }
  }

  try {
    unsubscribe = navigation.addListener('state', onState)
    pushHost()
  } catch (error) {
    dispose()
    throw error
  }
  return {
    cancel: dispose,
    isActive: () => active,
    retarget: (target, openInHostDocument) => {
      if (active) {
        latest = [target, openInHostDocument]
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
    current.controller.retarget(target, openInHostDocument)
    return current
  }
  current?.controller.cancel()
  return {
    hostId,
    controller: navigateToHostStackRoute(navigation, router, hostId, target, openInHostDocument)
  }
}
