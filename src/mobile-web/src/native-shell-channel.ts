import { postPageMessage, postPageReady } from './native-shell-page-frames'
import { MobileWebPageStateSchema } from '../../shared/mobile-web/bridge-route-contract'
import { setMobileWebPagePreferencesClient } from './mobile-web-page-preferences-channel'
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgeInitialMessage,
  parseMobileWebBridgeShellMessage,
  type MobileWebBridgeMessageContext,
  type MobileWebConnectionState,
  type MobileWebNavigationRoute,
  type MobileWebResumeRoute
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'
import { dispatchMobileWebHardwareBack } from './mobile-web-hardware-back-handler'
import {
  nextMobileWebShellConnectionMetrics,
  type MobileWebShellConnectionMetrics
} from './mobile-web-shell-connection-metrics'
import { subscribeToMobileWebShellMessages } from './native-shell-message-inbox'

export type MobileWebNativeShellState = {
  client: MobileWebBridgeClient | null
  context: MobileWebBridgeMessageContext | null
  connection: MobileWebConnectionState
  hostDisplayName: string | null
  reconnectAttempts: number
  lastConnectedAt: number | null
  navigationRoute: MobileWebNavigationRoute
  resumeRoute: MobileWebResumeRoute
  routeRevision: number
  pageState?: string
  rememberRoute: (route: MobileWebResumeRoute, pageState?: string) => boolean
}

const MobileWebNativeShellContext = createContext<MobileWebNativeShellState | null>(null)

export function MobileWebNativeShellProvider({ children }: { children: ReactNode }): ReactElement {
  const state = useMobileWebNativeShellChannel()
  return createElement(MobileWebNativeShellContext.Provider, { value: state }, children)
}

export function useMobileWebNativeShell(): MobileWebNativeShellState {
  const state = useContext(MobileWebNativeShellContext)
  if (!state) {
    throw new Error('useMobileWebNativeShell must be used inside MobileWebNativeShellProvider')
  }
  return state
}

function useMobileWebNativeShellChannel(): MobileWebNativeShellState {
  const [state, setState] = useState<MobileWebNativeShellState>({
    client: null,
    context: null,
    connection: 'connecting',
    hostDisplayName: null,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    navigationRoute: { kind: 'workspaceList' },
    resumeRoute: { kind: 'workspaceList' },
    routeRevision: 0,
    rememberRoute: () => false
  })

  useEffect(() => {
    let context: MobileWebBridgeMessageContext | null = null
    let client: MobileWebBridgeClient | null = null
    let hostDisplayName: string | null = null
    let metrics: MobileWebShellConnectionMetrics = {
      reconnectAttempts: 0,
      lastConnectedAt: null
    }
    let navigationRoute: MobileWebNavigationRoute = { kind: 'workspaceList' }
    let resumeRoute: MobileWebResumeRoute = { kind: 'workspaceList' }
    let pageState: string | undefined
    let routeRevision = 0
    let lastNavigationSequence = -1
    let rememberRoute = (_route: MobileWebResumeRoute, _pageState?: string): boolean => false
    let healthFrame = 0
    let interactiveFrame = 0
    const receive = (raw: string): void => {
      const init = parseInitialMessage(raw)
      if (init) {
        const nextContext = { shellSessionId: init.shellSessionId, buildId: init.buildId }
        const retainsContext = sameContext(context, nextContext)
        metrics = nextMobileWebShellConnectionMetrics(metrics, init, retainsContext)
        hostDisplayName = init.hostDisplayName ?? null
        if (!retainsContext) {
          resumeRoute = init.resumeRoute ?? { kind: 'workspaceList' }
          navigationRoute = resumeRoute
          pageState = init.pageState
          routeRevision += 1
          lastNavigationSequence = -1
        }
        rememberRoute = (route, nextPageState) => {
          if (!sameContext(context, nextContext)) {
            return false
          }
          if (
            nextPageState !== undefined &&
            !MobileWebPageStateSchema.safeParse(nextPageState).success
          ) {
            return false
          }
          pageState = nextPageState
          resumeRoute = route
          navigationRoute = route
          setState((current) =>
            sameContext(current.context, nextContext)
              ? { ...current, navigationRoute: route, resumeRoute: route, pageState }
              : current
          )
          return postPageMessage({
            version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
            ...nextContext,
            type: 'routeState',
            pageState,
            route
          })
        }
        if (retainsContext && client) {
          setState({
            client,
            context,
            connection: init.connection,
            hostDisplayName,
            navigationRoute,
            resumeRoute,
            pageState,
            routeRevision,
            rememberRoute,
            ...metrics
          })
          postPageReady(nextContext)
          scheduleInteractiveHealth(nextContext)
          return
        }
        client?.dispose()
        context = nextContext
        client = new MobileWebBridgeClient({
          context,
          grants: init.grants,
          postMessage: postPageMessage
        })
        setMobileWebPagePreferencesClient(client)
        setState({
          client,
          context,
          connection: init.connection,
          hostDisplayName,
          navigationRoute,
          resumeRoute,
          pageState,
          routeRevision,
          rememberRoute,
          ...metrics
        })
        postPageReady(context)
        scheduleInteractiveHealth(context)
        return
      }
      if (!context || !client) {
        return
      }
      const activeContext = context
      const parsed = parseMobileWebBridgeShellMessage(raw, activeContext)
      if (!parsed.ok) {
        return
      }
      if (parsed.value.type === 'navigation') {
        if (parsed.value.sequence <= lastNavigationSequence) {
          return
        }
        lastNavigationSequence = parsed.value.sequence
        navigationRoute = parsed.value.route
        pageState = parsed.value.pageState
        if (
          pageState !== undefined &&
          (navigationRoute.kind === 'session' || navigationRoute.kind === 'workspaceList')
        ) {
          resumeRoute = navigationRoute
        }
        routeRevision += 1
        setState((current) =>
          sameContext(current.context, activeContext)
            ? { ...current, navigationRoute, resumeRoute, pageState, routeRevision, rememberRoute }
            : current
        )
        return
      }
      if (parsed.value.type === 'hardwareBack') {
        postPageMessage({
          version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
          ...activeContext,
          type: 'hardwareBackResult',
          sequence: parsed.value.sequence,
          handled: dispatchMobileWebHardwareBack()
        })
        return
      }
      client.receive(parsed.value)
      if (parsed.value.type === 'connection') {
        metrics = nextMobileWebShellConnectionMetrics(metrics, parsed.value, true)
        setState({
          client,
          context,
          connection: parsed.value.state,
          hostDisplayName,
          navigationRoute,
          resumeRoute,
          pageState,
          routeRevision,
          rememberRoute,
          ...metrics
        })
      }
    }
    const scheduleInteractiveHealth = (messageContext: MobileWebBridgeMessageContext): void => {
      cancelAnimationFrame(healthFrame)
      cancelAnimationFrame(interactiveFrame)
      healthFrame = requestAnimationFrame(() => {
        interactiveFrame = requestAnimationFrame(() => {
          if (sameContext(context, messageContext)) {
            postPageMessage({
              version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
              ...messageContext,
              type: 'health',
              state: 'interactive'
            })
          }
        })
      })
    }
    const unsubscribe = subscribeToMobileWebShellMessages(window, receive)
    const onRouteFailure = (): void => {
      cancelAnimationFrame(healthFrame)
      cancelAnimationFrame(interactiveFrame)
    }
    window.addEventListener('orca-mobile-web-route-failure', onRouteFailure)
    return () => {
      context = null
      unsubscribe()
      window.removeEventListener('orca-mobile-web-route-failure', onRouteFailure)
      client?.dispose()
      setMobileWebPagePreferencesClient(null)
      cancelAnimationFrame(healthFrame)
      cancelAnimationFrame(interactiveFrame)
    }
  }, [])

  return state
}

function parseInitialMessage(raw: string) {
  const parsed = parseMobileWebBridgeInitialMessage(raw)
  return parsed.ok ? parsed.value : null
}

function sameContext(
  left: MobileWebBridgeMessageContext | null,
  right: MobileWebBridgeMessageContext
): boolean {
  return left?.shellSessionId === right.shellSessionId && left.buildId === right.buildId
}
