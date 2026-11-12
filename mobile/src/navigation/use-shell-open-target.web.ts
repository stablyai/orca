import { use, useEffect, useLayoutEffect, useState } from 'react'
import { Navigator, useNavigationContainerRef, useRouter } from 'expo-router'
// The resolver and linking config router.push goes through; reading them keeps one resolver for both open paths.
import { getStateForHref } from 'expo-router/build/link/getStateForHref'
import { RouterConfigContext } from 'expo-router/build/global-state/routerConfigContext'
import { getRouteInfoFromState } from 'expo-router/build/global-state/getRouteInfoFromState'
import type { ExpoLinkingOptions } from 'expo-router/build/getLinkingConfig'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-init-route'
import { BRIDGE_OPEN_ROUTE_PARAM } from '../mobile-web-shell/bridge/bridge-route-update'
import { usePageBridgeClient } from '../transport/connection/client-context.web'
import { createRefusalReporter, handOffRoute, servedHere } from './route-handoff.web'

type StackState = ReturnType<typeof Navigator.useContext>['state']
type StackRoute = { name: string; params?: object }
type OpenSplice = { target: string; state: object }

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
function stackRouteForHref(
  href: string,
  linking: ExpoLinkingOptions | undefined,
  routeNames: readonly string[]
): StackRoute | null {
  let state
  try {
    // Open targets are absolute, so no current segments are needed to resolve them.
    state = getStateForHref(href, { segments: [] }, linking)
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

// Open the first init's target as part of the stack's first state, so its chunk loads with the document like a fresh one and the cover drops on its paint.
// Reads the target the URL was built from, and is pure so React can discard a suspended first render and plan again the same way.
function planOpenSplice(
  state: StackState,
  linking: ExpoLinkingOptions | undefined,
  opensHere: (target: string) => boolean
): OpenSplice | null {
  const [only, ...others] = state.routes
  const params: Record<string, unknown> = { ...only?.params }
  const target = params[BRIDGE_OPEN_ROUTE_PARAM]
  if (only === undefined || others.length > 0 || typeof target !== 'string' || !opensHere(target)) {
    return null
  }
  const opened = stackRouteForHref(target, linking, state.routeNames)
  if (opened === null) {
    return null
  }
  delete params[BRIDGE_OPEN_ROUTE_PARAM]
  return { target, state: { ...state, index: 1, routes: [{ ...only, params }, opened] } }
}

function decodedPathnameOf(href: string): string {
  try {
    return decodeURIComponent(new URL(href, 'orca-page://document').pathname)
  } catch {
    return href
  }
}

function searchParamsOf(href: string): Record<string, string> {
  return Object.fromEntries(new URL(href, 'orca-page://document').searchParams)
}

// The shell names a target to open inside this document (Jump back in, notification taps) instead of pushing a second one.
// Call inside the stack navigator; true while the first init's target is still being spliced in, so the stack draws nothing yet.
export function useShellOpenTarget(): boolean {
  const client = usePageBridgeClient()
  const router = useRouter()
  const container = useNavigationContainerRef()
  const { state, navigation } = Navigator.useContext()
  const linking = use(RouterConfigContext)?.linking
  const [splice] = useState(() =>
    planOpenSplice(state, linking, (target) => opensInDocument(client, target))
  )
  const [opening, setOpening] = useState(splice !== null)

  // Seeded navigation state can no longer be rewritten by the router, so splice before the first paint.
  useLayoutEffect(() => {
    if (opening && splice !== null) {
      navigation.dispatchSync({ type: 'RESET', payload: splice.state })
      setOpening(false)
    }
  }, [navigation, opening, splice])

  useEffect(() => {
    const report = createRefusalReporter()
    let applied = splice?.target ?? null
    const place = (target: string): void => {
      // Already on top: a second copy would only stack the same screen under itself, so hand it the target's params (a notification's pane) instead.
      if (decodedPathnameOf(target) === getRouteInfoFromState(container.getRootState()).pathname) {
        const params = searchParamsOf(target)
        if (Object.keys(params).length > 0) {
          router.setParams(params)
        }
        return
      }
      router.push(target)
    }
    const open = (target: string): void => {
      if (!isThisHost(client, target)) {
        console.warn('[page-bridge] open-target-refused', { target })
        return
      }
      // Unserved targets go back to the shell, which pushes them natively as it did before page version 2.
      if (handOffRoute(client, target, report) !== 'local') {
        return
      }
      place(target)
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
    return client.onRouteUpdate(receive)
  }, [client, container, router, splice])

  return opening
}
