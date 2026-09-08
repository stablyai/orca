import { useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'expo-router'
import {
  hostedPageRouteState,
  hostedPageStateTarget
} from '../src/mobile-web/hosted-page-route-state'

import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import { mobileWebNavigationRouteTarget } from '../src/mobile-web/mobile-web-route-restoration'
import { rememberMobileWebRouteQuery } from '../src/mobile-web/mobile-web-route-query-cache'

export function MobileWebRouteRestorer() {
  const router = useRouter()
  const pathname = usePathname()
  const pendingPathRef = useRef<string | undefined>(undefined)
  const shell = useMobileWebNativeShell()
  const restoredContextRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!shell.context) {
      return
    }
    const restorationKey = `${shell.context.shellSessionId}:${shell.context.buildId}:${shell.routeRevision}`
    if (restoredContextRef.current === restorationKey) {
      return
    }
    restoredContextRef.current = restorationKey
    const pageTarget = hostedPageStateTarget(shell.pageState)
    const target = pageTarget ?? mobileWebNavigationRouteTarget(shell.navigationRoute)
    const query = pageTarget ? {} : navigationRouteQuery(shell.navigationRoute)
    pendingPathRef.current = new URL(target, 'https://orca-mobile-web.invalid').pathname
    rememberNavigationRouteQuery(target, query)
    router.replace(mobileWebRouterReplacementHref(target, query))
  }, [router, shell.context, shell.navigationRoute, shell.pageState, shell.routeRevision])

  useEffect(() => {
    if (!shell.context || (pendingPathRef.current && pendingPathRef.current !== pathname)) {
      return
    }
    pendingPathRef.current = undefined
    const pageState = hostedPageRouteState(pathname)
    if (pageState !== shell.pageState) {
      shell.rememberRoute(shell.resumeRoute, pageState)
    }
  }, [pathname, shell.context, shell.pageState, shell.rememberRoute, shell.resumeRoute])

  return null
}

function rememberNavigationRouteQuery(
  target: string,
  query: Readonly<Record<string, string | undefined>>
): void {
  const pathname = new URL(target, 'https://orca-mobile-web.invalid').pathname
  rememberMobileWebRouteQuery(pathname, query)
}

function navigationRouteQuery(
  route: ReturnType<typeof useMobileWebNativeShell>['navigationRoute']
): Readonly<Record<string, string | undefined>> {
  if (route.kind === 'session') {
    return { name: route.workspaceName }
  }
  if (route.kind === 'tasks') {
    return { taskSource: route.taskSource }
  }
  if (route.kind === 'newWorkspace') {
    return { action: 'newWorktree' }
  }
  if (route.kind === 'workspaceList') {
    return { notice: route.notice }
  }
  return {}
}

function mobileWebRouterReplacementHref(
  target: string,
  query: Readonly<Record<string, string | undefined>>
): string {
  const url = new URL(target, 'https://orca-mobile-web.invalid')
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, value)
    }
  }
  return `${url.pathname}${url.search}`
}
