const NATIVE_HOST_MANAGEMENT_ROUTE = /^\/h\/[^/]+\/edit$/

export type MobileHostRouteOwner = 'native-shell' | 'workspace' | 'outside-host'

export function mobileHostRouteOwner(pathname: string): MobileHostRouteOwner {
  if (NATIVE_HOST_MANAGEMENT_ROUTE.test(pathname)) {
    return 'native-shell'
  }
  return pathname === '/h' || pathname.startsWith('/h/') ? 'workspace' : 'outside-host'
}

export function isRetiredNativeWorkspaceRoute(
  pathname: string,
  nativeBaselineEnabled = false
): boolean {
  return !nativeBaselineEnabled && mobileHostRouteOwner(pathname) === 'workspace'
}

export function retiredNativeWorkspaceHostId(pathname: string): string | undefined {
  if (mobileHostRouteOwner(pathname) !== 'workspace') {
    return undefined
  }
  const segment = pathname.split('/')[2]
  return segment ? decodeURIComponentSafely(segment) : undefined
}

function decodeURIComponentSafely(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}
