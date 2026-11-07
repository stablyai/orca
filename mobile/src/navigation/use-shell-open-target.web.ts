import { useEffect, useRef, useState } from 'react'
import { useNavigationContainerRef, useRouter } from 'expo-router'
// Expo Router's own stack router, the one Navigator falls back to; not re-exported from the package root.
import { StackRouter } from 'expo-router/build/layouts/StackClient'
// The store router.push resolves hrefs through; reading it keeps one resolver for both open paths.
import { store } from 'expo-router/build/global-state/router-store'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-init-route'
import { BRIDGE_OPEN_ROUTE_PARAM } from '../mobile-web-shell/bridge/bridge-route-update'
import { usePageBridgeClient } from '../transport/client-context.web'
import { createRefusalReporter, handOffRoute, servedHere } from './route-handoff.web'

type StackRouterFactory = typeof StackRouter
type StackRoute = { name: string; params?: object }

function openTargetOf(route: BridgeInitRoute | null | undefined): string {
  return route?.params?.[BRIDGE_OPEN_ROUTE_PARAM] ?? ''
}

// The document's host owns its client, profile and grants, so another host's target never opens inside it.
function isThisHost(client: BridgeRpcClient, target: string): boolean {
  const host = client.getShellSession()?.route?.pathname.match(/^\/h\/[^/]+/)?.[0]
  return host !== undefined && target.startsWith(`${host}/`)
}

function opensInDocument(client: BridgeRpcClient, target: string): boolean {
  return isThisHost(client, target) && servedHere(client, target)
}

// Resolve through Expo's own linking, as router.push would, and take the route at this stack's level.
// A target Expo cannot read (a malformed escape) opens nothing rather than throwing inside the navigator's render.
function stackRouteForHref(href: string, routeNames: readonly string[]): StackRoute | null {
  let state
  try {
    state = store.getStateForHref(href)
  } catch {
    return null
  }
  while (state?.routes !== undefined) {
    const route: (StackRoute & { state?: typeof state }) | undefined = state.routes.at(-1)
    if (route === undefined) {
      return null
    }
    if (routeNames.includes(route.name)) {
      return { name: route.name, params: route.params }
    }
    state = route.state
  }
  return null
}

// Open the first init's target as part of the stack's initial state, so its chunk loads with the document like a fresh one and the cover drops on its paint.
// Reads the target the URL was built from, and is pure so React can discard a suspended first render and hydrate again the same way.
function shellOpenStackRouter(
  opensHere: (target: string) => boolean,
  onSpliced: (target: string) => void
): StackRouterFactory {
  return (options) => {
    const router = StackRouter(options)
    return {
      ...router,
      getRehydratedState: (partial, config) => {
        const [only, ...others] = partial.routes
        const params: Record<string, unknown> = { ...only?.params }
        const target = params[BRIDGE_OPEN_ROUTE_PARAM]
        if (
          only === undefined ||
          others.length > 0 ||
          partial.stale === false ||
          typeof target !== 'string' ||
          !opensHere(target)
        ) {
          return router.getRehydratedState(partial, config)
        }
        const opened = stackRouteForHref(target, config.routeNames)
        if (opened === null) {
          return router.getRehydratedState(partial, config)
        }
        onSpliced(target)
        delete params[BRIDGE_OPEN_ROUTE_PARAM]
        return router.getRehydratedState(
          { stale: true, index: 1, routes: [{ name: only.name, params }, opened] },
          config
        )
      }
    }
  }
}

function decodedPathnameOf(href: string): string {
  try {
    return decodeURIComponent(new URL(href, 'orca-page://document').pathname)
  } catch {
    return href
  }
}

// The shell names a target to open inside this document (Jump back in, notification taps) instead of pushing a second one.
// Returns the stack router that opens the first init's target; later inits push theirs in-page.
export function useShellOpenTarget(): StackRouterFactory {
  const client = usePageBridgeClient()
  const router = useRouter()
  const navigation = useNavigationContainerRef()
  // What the router put in the stack, so a later init only opens a different target.
  const spliced = useRef<string | null>(null)
  const [stackRouter] = useState(() =>
    shellOpenStackRouter(
      (target) => opensInDocument(client, target),
      (target) => {
        spliced.current = target
      }
    )
  )

  useEffect(() => {
    const report = createRefusalReporter()
    let applied = spliced.current
    // A route update can land before the root navigator is ready; Expo Router refuses to route until then.
    let waiting: string | null = null
    const stopWaiting = navigation.addListener('ready', () => {
      if (waiting !== null) {
        router.push(waiting)
        waiting = null
      }
    })
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
      if (decodedPathnameOf(target) === store.getRouteInfo().pathname) {
        return
      }
      if (navigation.isReady()) {
        router.push(target)
      } else {
        waiting = target
      }
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
      stopWaiting()
    }
  }, [client, navigation, router])

  return stackRouter
}
