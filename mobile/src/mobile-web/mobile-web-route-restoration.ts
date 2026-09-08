import type {
  MobileWebNavigationRoute,
  MobileWebResumeRoute
} from '../../../src/shared/mobile-web/bridge-contract'

const HOSTED_PAGE_HOST_ID = 'paired-orca-desktop'

export function mobileWebResumeRouteTarget(route: MobileWebResumeRoute): string | null {
  const target = mobileWebNavigationRouteTarget(route)
  return target === '/' ? null : target
}

export function mobileWebNavigationRouteTarget(route: MobileWebNavigationRoute): string {
  if (route.kind === 'workspaceList') {
    return '/'
  }
  if (route.kind === 'tasks') {
    return `/h/${HOSTED_PAGE_HOST_ID}/tasks`
  }
  if (route.kind === 'accounts') {
    return `/h/${HOSTED_PAGE_HOST_ID}/accounts`
  }
  if (route.kind === 'newWorkspace') {
    return '/'
  }
  return `/h/${HOSTED_PAGE_HOST_ID}/session/${encodeURIComponent(route.workspaceId)}`
}
