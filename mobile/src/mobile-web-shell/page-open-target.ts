import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS } from '../transport/web-bundle/mobile-web-bundle-compat'
import { BRIDGE_MAX_ROUTE_PARAM_CHARS } from './bridge/bridge-caps'
import type { BridgeInitRoute } from './bridge/bridge-envelope'
import {
  BRIDGE_OPEN_ROUTE_PARAM,
  type BridgeClearableRouteParam
} from './bridge/bridge-route-update'

type PageLocation = Readonly<{ sessionId: string; href: string }>

// What `open` the shown page gets. It waits for the build the shell activates: a page older than `open` gets the target pushed natively,
// as it would hand back a route it doesn't serve. A document that replaces a lost one (renderer loss, retry) reopens where its page last was.
export function usePageOpenTarget(args: {
  route: BridgeInitRoute
  sessionId: string | null
  pageVersion: number | null
  isFocused: () => boolean
  openNatively: (href: string) => void
  onRouteParamClear?: (param: BridgeClearableRouteParam, value: string) => void
}): {
  pageRoute: BridgeInitRoute
  recordLocation: (href: string) => void
  onRouteParamClear: (param: BridgeClearableRouteParam, value: string) => void
} {
  const { route, sessionId, pageVersion } = args
  const [located, setLocated] = useState<PageLocation | null>(null)
  const [restore, setRestore] = useState<string | null>(null)
  if (sessionId !== null && located !== null && located.sessionId !== sessionId) {
    setLocated({ sessionId, href: located.href })
    // Only a place inside this screen, like a session its host list opened, that fits the param.
    const restorable =
      located.href.startsWith(`${route.pathname}/`) &&
      located.href.length <= BRIDGE_MAX_ROUTE_PARAM_CHARS
    setRestore(restorable ? located.href : null)
  }
  const requested = route.params?.[BRIDGE_OPEN_ROUTE_PARAM]
  const opensTargets = pageVersion !== null && pageVersion >= MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS
  const goesNative = requested !== undefined && pageVersion !== null && !opensTargets
  const open = goesNative
    ? undefined
    : (requested ?? (opensTargets ? (restore ?? undefined) : undefined))

  const pageRoute = useMemo(() => {
    if (open === requested) {
      return route
    }
    const { [BRIDGE_OPEN_ROUTE_PARAM]: _requested, ...params } = route.params ?? {}
    return {
      ...route,
      params: open === undefined ? params : { ...params, [BRIDGE_OPEN_ROUTE_PARAM]: open }
    }
  }, [open, requested, route])

  const pushNatively = useEffectEvent((target: string) => {
    args.onRouteParamClear?.(BRIDGE_OPEN_ROUTE_PARAM, target)
    // A screen opened on top while this page downloaded is newer than the tap.
    if (args.isFocused()) {
      args.openNatively(target)
    }
  })
  useEffect(() => {
    if (goesNative) {
      pushNatively(requested)
    }
  }, [goesNative, requested])

  return {
    pageRoute,
    recordLocation: (href) => {
      if (sessionId !== null) {
        setLocated((current) =>
          current?.sessionId === sessionId && current.href === href ? current : { sessionId, href }
        )
      }
    },
    onRouteParamClear: (param, value) => {
      // Any `open` the page took, restored or tapped since, is newer than the place to restore.
      if (param === BRIDGE_OPEN_ROUTE_PARAM) {
        setRestore(null)
      }
      args.onRouteParamClear?.(param, value)
    }
  }
}
