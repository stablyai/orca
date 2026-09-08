import { createSettingsAuthority } from '../src/mobile-web/mobile-web-hosted-settings-authority'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobileWebShellViewRef } from '@orca/expo-mobile-web-shell'
import * as ExpoCrypto from 'expo-crypto'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../src/shared/mobile-web/bridge-contract'
import { MobileWebCapabilityBroker } from '../src/mobile-web/mobile-web-capability-broker'
import {
  useMobileWebCapabilityBroker,
  type MobileWebBrokerPageIdentity
} from '../src/mobile-web/use-mobile-web-capability-broker'
import { useMobileWebPageDocument } from '../src/mobile-web/use-mobile-web-page-document'
import { mobileWebShellInitMessage } from '../src/mobile-web/mobile-web-shell-init-message'
import { useMobileWebPackageSession } from '../src/mobile-web/use-mobile-web-package-session'
import { mobileWebNativeAlertLifecycle } from '../src/mobile-web/mobile-web-native-alert'
import { MobileWebHybridShellPresentation } from '../src/mobile-web/MobileWebHybridShellPresentation'
import { useMobileWebNavigationIntentHandoff } from '../src/mobile-web/use-mobile-web-navigation-intent-handoff'
import { useMobileWebColdResumeRoute } from '../src/mobile-web/use-mobile-web-cold-resume-route'
import { MobileWebOneShotResponseDrop } from '../src/mobile-web/mobile-web-one-shot-response-drop'
import { useMobileWebE2eHostSelection } from '../src/mobile-web/mobile-web-e2e-host-selection'
import { useMobileWebAppForegroundAuthority } from '../src/mobile-web/use-mobile-web-app-foreground-authority'
import { useMobileWebHostCatalog } from '../src/mobile-web/use-mobile-web-host-catalog'
import { mobileWebDiagnosticsStore } from '../src/mobile-web/mobile-web-diagnostics-store'
import { useMobileWebBridgeRuntimeRef } from '../src/mobile-web/use-mobile-web-bridge-runtime-ref'
import { useMobileWebResumeRouteMemory } from '../src/mobile-web/use-mobile-web-resume-route-memory'
import { useMobileWebHardwareBackHandoff } from '../src/mobile-web/use-mobile-web-hardware-back-handoff'
import { useMobileWebNavigationAuthority } from '../src/mobile-web/use-mobile-web-navigation-authority'
import {
  useRpcClientContext,
  useForceReconnect,
  useForgetHostClient,
  useHostClient
} from '../src/transport/client-context'
import {
  useLastConnectedAt,
  useReconnectAttempt
} from '../src/transport/client-context-connection-metrics'
import { leaveHostRoute } from '../src/host-route-exit'

export default function HybridScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ hostId?: string }>()
  const viewRef = useRef<MobileWebShellViewRef>(null)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const brokerRef = useRef<MobileWebCapabilityBroker | null>(null)
  const postInitRef = useRef<() => Promise<void>>(() => Promise.resolve())
  useMobileWebAppForegroundAuthority(brokerRef)
  const responseDropRef = useRef(
    new MobileWebOneShotResponseDrop(process.env.EXPO_PUBLIC_ORCA_E2E_MOBILE_WEB_DROP_RESPONSE_ONCE)
  )
  const { hosts, hostsLoading, hostLoadError, refreshHosts } = useMobileWebHostCatalog()
  const [selectedHostId, setSelectedHostId] = useState<string | undefined>(params.hostId)
  const [brokerSessionId, setBrokerSessionId] = useState<string>()
  const [hostedViewActive, setHostedViewActive] = useState(true)
  const selectHost = useCallback((hostId: string | undefined) => setSelectedHostId(hostId), [])
  const resumeRoute = useMobileWebResumeRouteMemory(selectedHostId)
  const e2eHostId = useMobileWebE2eHostSelection(hosts, selectedHostId, selectHost)
  const { client, state } = useHostClient(selectedHostId)
  const clientContext = useRpcClientContext()
  const closeHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()
  const reconnects = useReconnectAttempt(selectedHostId)
  const lastConnected = useLastConnectedAt(selectedHostId)
  const selectedHost = useMemo(
    () => hosts.find((host) => host.id === selectedHostId),
    [hosts, selectedHostId]
  )
  const hostName = selectedHost?.name
  const {
    session,
    sessionHostId,
    viewEpoch,
    packageLoading,
    packageProgress,
    packageWarning,
    handleLoadFailure,
    handleProcessTerminated,
    showWarning
  } = useMobileWebPackageSession({
    client,
    host: selectedHost,
    state,
    // A native alert owns the screen; replacing the session under it strands the dialog.
    beforeSessionReplacement: mobileWebNativeAlertLifecycle.waitForIdle
  })
  const bridgeRuntimeRef = useMobileWebBridgeRuntimeRef(client, state, session?.sessionId)
  const coldResumeRoute = useMobileWebColdResumeRoute({
    hosts,
    hostsLoading,
    hostsLoadFailed: hostLoadError,
    explicitHostId: params.hostId ?? e2eHostId,
    selectedHostId,
    shellSessionId: session?.sessionId,
    selectHost
  })
  const handleBack = useCallback(() => {
    coldResumeRoute.clearRoute()
    leaveHostRoute(router)
  }, [coldResumeRoute.clearRoute, router])

  useEffect(() => {
    if (hostsLoading || selectedHost || e2eHostId) {
      return
    }
    coldResumeRoute.clearRoute()
    leaveHostRoute(router)
  }, [coldResumeRoute.clearRoute, e2eHostId, hostsLoading, router, selectedHost])

  useEffect(() => {
    activeSessionIdRef.current = sessionHostId === selectedHostId ? session?.sessionId : undefined
  }, [selectedHostId, session?.sessionId, sessionHostId])

  useFocusEffect(
    useCallback(() => {
      setHostedViewActive(true)
      const sessionId = session?.sessionId
      const view = viewRef.current
      if (sessionId && view) {
        void view.activateSessionView(sessionId).catch(() => {
          if (activeSessionIdRef.current === sessionId) {
            showWarning('Couldn’t reopen Orca. Try again.', 'session_reopen_failed')
          }
        })
      }
      return () => setHostedViewActive(false)
    }, [session?.sessionId, showWarning])
  )

  useEffect(() => {
    if (params.hostId) {
      setSelectedHostId(params.hostId)
    }
  }, [params.hostId])

  const pageDocument = useMobileWebPageDocument({
    sessionId: session?.sessionId,
    viewEpoch
  })

  const postToWeb = useCallback(async (message: MobileWebBridgeShellMessage) => {
    if (responseDropRef.current.shouldDrop(message)) {
      return
    }
    const view = viewRef.current
    if (!view) {
      return
    }
    await view.postMessage(JSON.stringify(message))
  }, [])
  const hardwareBackHandoff = useMobileWebHardwareBackHandoff({
    shellSessionId: session?.sessionId,
    buildId: session?.buildId,
    forwardingEnabled: hostedViewActive,
    postMessage: postToWeb,
    onUnhandled: handleBack
  })

  const navigationAuthority = useMobileWebNavigationAuthority({
    hostId: selectedHost?.id,
    hostPublicKeyB64: selectedHost?.publicKeyB64,
    router,
    clearColdResumeRoute: coldResumeRoute.clearRoute,
    closeHostClient,
    forceReconnectHost
  })
  const createBroker = useCallback(
    (page: MobileWebBrokerPageIdentity) => {
      if (!selectedHost || sessionHostId !== selectedHostId) {
        return null
      }
      return new MobileWebCapabilityBroker({
        context: { shellSessionId: page.sessionId, buildId: page.buildId },
        getClient: () =>
          bridgeRuntimeRef.current.sessionId === page.sessionId
            ? bridgeRuntimeRef.current.client
            : null,
        isConnected: () =>
          bridgeRuntimeRef.current.sessionId === page.sessionId &&
          bridgeRuntimeRef.current.state === 'connected',
        isActive: () => activeSessionIdRef.current === page.sessionId,
        postMessage: postToWeb,
        nativeAuthority: createSettingsAuthority(selectedHost, page.buildId, clientContext),
        navigationAuthority,
        terminalClientId: selectedHost.deviceToken,
        onTerminalFlowMetrics: (metrics) =>
          mobileWebDiagnosticsStore.terminalFlow(selectedHost.id, metrics),
        onTerminalResync: (reason) =>
          mobileWebDiagnosticsStore.terminalResync(selectedHost.id, reason),
        rememberRoute(route, pageState) {
          resumeRoute.remember(route, pageState)
        },
        rememberHostRoute: coldResumeRoute.rememberHostRoute,
        randomBytes: ExpoCrypto.getRandomBytes
      })
    },
    [
      clientContext,
      coldResumeRoute.rememberHostRoute,
      navigationAuthority,
      postToWeb,
      resumeRoute,
      selectedHost?.deviceToken,
      selectedHost?.id,
      selectedHost?.publicKeyB64,
      sessionHostId,
      selectedHostId
    ]
  )
  const onBrokerReady = useCallback(() => {
    void postInitRef.current().catch(() => {})
  }, [])
  const { retireBroker } = useMobileWebCapabilityBroker({
    brokerRef,
    sessionId: session?.sessionId,
    buildId: session?.buildId,
    viewEpoch,
    documentEpoch: pageDocument.epoch,
    createBroker,
    onBrokerReady,
    onBrokerSessionChange: setBrokerSessionId
  })

  useEffect(() => {
    brokerRef.current?.replaceClient(client)
  }, [client])

  const postInit = useCallback(async () => {
    const current = session
    if (!current || activeSessionIdRef.current !== current.sessionId || !brokerRef.current) {
      return
    }
    pageDocument.initializedSessionRef.current = current.sessionId
    await postToWeb(
      mobileWebShellInitMessage({
        shellSessionId: current.sessionId,
        buildId: current.buildId,
        state,
        hostDisplayName: hostName,
        reconnectAttempts: reconnects,
        lastConnectedAt: lastConnected,
        resumeRoute: resumeRoute.current(),
        pageState: resumeRoute.pageState()
      })
    )
  }, [hostName, lastConnected, postToWeb, reconnects, resumeRoute, session, state])
  useEffect(() => {
    postInitRef.current = postInit
  }, [postInit])

  useEffect(() => {
    brokerRef.current?.updateConnectionState(state)
    const current = session
    if (!current || pageDocument.initializedSessionRef.current !== current.sessionId) {
      return
    }
    void postToWeb({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'connection',
      shellSessionId: current.sessionId,
      buildId: current.buildId,
      state,
      reconnectAttempts: reconnects,
      lastConnectedAt: lastConnected
    })
  }, [lastConnected, postToWeb, reconnects, session, state])

  const handleBridgeMessage = useCallback(
    async (raw: string) => {
      const current = session
      if (!current || activeSessionIdRef.current !== current.sessionId) {
        return
      }
      const parsed = parseMobileWebBridgePageMessage(raw, {
        shellSessionId: current.sessionId,
        buildId: current.buildId
      })
      if (!parsed.ok) {
        return
      }
      responseDropRef.current.recordRequest(parsed.value)
      const backMessageHandled = hardwareBackHandoff.handlePageMessage(parsed.value)
      if (parsed.value.type === 'ready') {
        // `ready` acknowledges init; echoing init here starves the health frame.
        if (activeSessionIdRef.current === current.sessionId) {
          pageDocument.setReadySessionId(current.sessionId)
        }
      } else if (!backMessageHandled) {
        if (parsed.value.type === 'routeState') {
          brokerRef.current?.rememberRoute(parsed.value.route, parsed.value.pageState)
        } else {
          await brokerRef.current?.handle(parsed.value)
        }
      }
    },
    [hardwareBackHandoff, postInit, session]
  )
  const shellContext = useMemo(
    () => (session ? { sessionId: session.sessionId, buildId: session.buildId } : null),
    [session?.buildId, session?.sessionId]
  )

  const getBroker = useCallback(() => brokerRef.current, [])
  const rememberRoute = resumeRoute.remember
  useMobileWebNavigationIntentHandoff({
    hosts,
    hostsLoading,
    selectedHostId,
    connectionState: state,
    shellContext,
    pageReadySessionId: pageDocument.readySessionId,
    brokerSessionId,
    getBroker,
    selectHost,
    refreshHosts,
    postMessage: postToWeb,
    rememberRoute,
    pageState: resumeRoute.pageState,
    onNavigationResolved: coldResumeRoute.onNavigationResolved,
    showWarning
  })

  return (
    <MobileWebHybridShellPresentation
      viewRef={viewRef}
      selectedHost={selectedHost}
      session={sessionHostId === selectedHostId ? session : null}
      viewEpoch={viewEpoch}
      // A session from the previously selected host must not render as ready for this one.
      packageLoading={
        packageLoading || !selectedHost || (session !== null && sessionHostId !== selectedHostId)
      }
      packageProgress={packageProgress}
      packageWarning={packageWarning}
      hostedViewActive={hostedViewActive}
      onBack={handleBack}
      onShowHosts={() => {
        coldResumeRoute.clearRoute()
        leaveHostRoute(router)
      }}
      onBridgeMessage={(message) => void handleBridgeMessage(message)}
      onDocumentLoadStarted={pageDocument.onLoadStart}
      onPageLoaded={() => {
        pageDocument.onLoaded()
        hardwareBackHandoff.resetPage()
        void postInit()
      }}
      onLoadFailed={handleLoadFailure}
      onNavigationBlocked={() => showWarning('That link can’t be opened here.')}
      onProcessTerminated={(sessionId) => {
        hardwareBackHandoff.resetPage()
        retireBroker()
        handleProcessTerminated(sessionId)
      }}
    />
  )
}
