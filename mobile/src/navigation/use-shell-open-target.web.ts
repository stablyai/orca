import { useEffect, useRef, useState } from 'react'
import { useNavigationContainerRef, usePathname, useRouter } from 'expo-router'
// Expo Router's own stack router, the one Navigator falls back to; not re-exported from the package root.
import { StackRouter } from 'expo-router/build/layouts/StackClient'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-init-route'
import { BRIDGE_OPEN_ROUTE_PARAM } from '../mobile-web-shell/bridge/bridge-route-update'
import { usePageBridgeClient } from '../transport/client-context.web'
import { createRefusalReporter, handOffRoute, servedHere } from './route-handoff.web'

type StackRouterFactory = typeof StackRouter
type StackParams = Record<string, string | string[]>
type StackRoute = { name: string; params: StackParams }

const DYNAMIC_SEGMENT = /^\[(\.\.\.)?(.+)\]$/

function openTargetOf(route: BridgeInitRoute | null | undefined): string {
  return route?.params?.[BRIDGE_OPEN_ROUTE_PARAM] ?? ''
}

// The document's host owns its client, profile and grants, so another host's target never opens inside it.
function isThisHost(client: BridgeRpcClient, target: string): boolean {
  const host = client.getShellSession()?.route?.pathname.match(/^\/h\/[^/]+/)?.[0]
  return host !== undefined && target.startsWith(`${host}/`)
}

function matchSegments(
  pattern: readonly string[],
  segments: readonly string[]
): StackParams | null {
  const params: StackParams = {}
  for (const [index, part] of pattern.entries()) {
    const dynamic = DYNAMIC_SEGMENT.exec(part)
    if (dynamic?.[1] !== undefined) {
      const rest = segments.slice(index)
      if (rest.length === 0 || index !== pattern.length - 1) {
        return null
      }
      params[dynamic[2]] = rest
      return params
    }
    const value = segments[index]
    if (value === undefined || value === '' || (dynamic === null && value !== part)) {
      return null
    }
    if (dynamic !== null) {
      params[dynamic[2]] = value
    }
  }
  return pattern.length === segments.length ? params : null
}

// A malformed escape names no screen; it must not throw inside the navigator's render.
function decodedPathSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').map(decodeURIComponent)
  } catch {
    return null
  }
}

// Resolve an /h/ href to this stack's screen: static segments beat dynamic ones and a catch-all comes last, as Expo ranks them.
export function stackRouteForHref(href: string, routeNames: readonly string[]): StackRoute | null {
  const url = new URL(href, 'orca-page://document')
  const segments = decodedPathSegments(url.pathname)?.slice(2)
  if (segments === undefined) {
    return null
  }
  let best: (StackRoute & { rank: number }) | null = null
  for (const name of routeNames) {
    const pattern = name
      .split('/')
      .filter((part, index, all) => part !== 'index' || index < all.length - 1)
    const params = matchSegments(pattern, segments)
    if (params === null) {
      continue
    }
    const rank =
      pattern.filter((part) => !DYNAMIC_SEGMENT.test(part)).length -
      (pattern.some((part) => part.startsWith('[...')) ? pattern.length : 0)
    if (best === null || rank > best.rank) {
      best = { name, params, rank }
    }
  }
  if (best === null) {
    return null
  }
  return { name: best.name, params: { ...Object.fromEntries(url.searchParams), ...best.params } }
}

// Open the first init's target as part of the stack's initial state, so its chunk loads with the document like a fresh one and the cover drops on its paint.
// Pure on purpose: React can discard a suspended first render and hydrate again, and each pass must splice the same way.
function shellOpenStackRouter(opensHere: (target: string) => boolean): StackRouterFactory {
  return (options) => {
    const router = StackRouter(options)
    return {
      ...router,
      getRehydratedState: (partial, config) => {
        const [only, ...others] = partial.routes
        const params: Record<string, unknown> = { ...only?.params }
        const target = params[BRIDGE_OPEN_ROUTE_PARAM]
        const opened =
          partial.stale !== false &&
          others.length === 0 &&
          typeof target === 'string' &&
          opensHere(target)
            ? stackRouteForHref(target, config.routeNames)
            : null
        if (only === undefined || opened === null) {
          return router.getRehydratedState(partial, config)
        }
        delete params[BRIDGE_OPEN_ROUTE_PARAM]
        return router.getRehydratedState(
          { stale: true, index: 1, routes: [{ name: only.name, params }, opened] },
          config
        )
      }
    }
  }
}

// The shell names a target to open inside this document (Jump back in, notification taps) instead of pushing a second one.
// Returns the stack router that opens the first init's target; later inits push theirs in-page.
export function useShellOpenTarget(): StackRouterFactory {
  const client = usePageBridgeClient()
  const router = useRouter()
  const navigation = useNavigationContainerRef()
  const pathname = useRef('')
  pathname.current = usePathname()
  const [opened] = useState(() => {
    const target = openTargetOf(client.getShellSession()?.route)
    return target !== '' && isThisHost(client, target) && servedHere(client, target) ? target : null
  })
  const [stackRouter] = useState(() => shellOpenStackRouter((target) => target === opened))

  useEffect(() => {
    const report = createRefusalReporter()
    let applied = opened
    let stopWaiting: (() => void) | null = null
    const open = (target: string): void => {
      if (!isThisHost(client, target)) {
        console.warn('[page-bridge] open-target-refused', { target })
        return
      }
      // Unserved targets go back to the shell, which pushes them natively as it did before page version 2.
      if (handOffRoute(client, target, report) !== 'local') {
        return
      }
      // Already on top: a second copy would only stack the same screen under itself.
      const path = new URL(target, 'orca-page://document').pathname
      if (decodedPathSegments(path)?.join('/') === pathname.current) {
        return
      }
      // A route update can land before the root navigator is ready; Expo Router refuses to route until then.
      if (navigation.isReady()) {
        router.push(target)
        return
      }
      stopWaiting?.()
      stopWaiting = navigation.addListener('ready', () => {
        stopWaiting?.()
        stopWaiting = null
        router.push(target)
      })
    }
    // Clear on every arrival so a lost acknowledgement is repaired, but open each value once so a replayed init cannot push it again.
    const receive = (route: BridgeInitRoute | null): void => {
      const target = openTargetOf(route)
      if (target === '') {
        applied = null
        return
      }
      client.clearRouteParam(BRIDGE_OPEN_ROUTE_PARAM, target)
      if (target !== applied) {
        applied = target
        open(target)
      }
    }
    receive(client.getShellSession()?.route ?? null)
    const unsubscribe = client.onRouteUpdate(receive)
    return () => {
      unsubscribe()
      stopWaiting?.()
    }
  }, [client, navigation, opened, router])

  return stackRouter
}
