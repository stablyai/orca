import type { HostStackNavigationRoute, HostStackRouteTarget } from './host-stack-navigation'

// Match decoded and encoded ids so slash/hash/percent host ids recognize their own push.
export function hostParamMatches(param: unknown, expectedHostId: string): boolean {
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

function routeParam(params: HostStackNavigationRoute['params'], name: string): unknown {
  return params ? Object.entries(params).find(([key]) => key === name)?.[1] : undefined
}

// A route's dynamic segments name its screen; a tap for the screen on show updates it instead of stacking a copy.
export function isSameScreen(
  focused: HostStackNavigationRoute,
  target: HostStackRouteTarget
): boolean {
  return [...target.name.matchAll(/\[(\w+)\]/g)].every(([, segment]) =>
    hostParamMatches(routeParam(focused.params, segment), target.params[segment] ?? '')
  )
}
