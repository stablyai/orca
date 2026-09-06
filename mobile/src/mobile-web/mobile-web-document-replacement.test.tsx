import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, useRef, type FunctionComponent } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import { MobileWebHealthDeadline } from './mobile-web-health-deadline'
import { MobileWebHybridShellPresentation } from './MobileWebHybridShellPresentation'
import { MobileWebNativeRouteHandoff } from './mobile-web-native-route-handoff'
import { useMobileWebCapabilityBroker } from './use-mobile-web-capability-broker'
import { useMobileWebPageDocument } from './use-mobile-web-page-document'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  MonitorSmartphone: 'MonitorSmartphone'
}))
vi.mock('@orca/expo-mobile-web-shell', () => ({ MobileWebShellView: 'MobileWebShellView' }))

const noop = (): void => {}
const SESSION_ID = 'S'.repeat(43)
const BUILD_ID = 'a'.repeat(64)

// A native-route excursion, the route error boundary's reload and a re-attach all replace the
// document while the shell session, its build and the view epoch stand still. The previous page's
// broker used to survive that, and its records held every per-operation grant (one for workspace),
// so the new document was refused with rate_limited for the life of the shell session.
describe('hosted document replacement', () => {
  let renderer: ReactTestRenderer | null = null
  let harness: ReturnType<typeof createHarness>

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('re-subscribes after a native-route excursion reloads the page', async () => {
    await mount()
    await loadDocument()
    await handle(subscribeRequest('A', 'Z'))
    expect(harness.subscribe).toHaveBeenCalledOnce()

    // The excursion deactivates the view (about:blank) and reactivates it on return; the page is
    // never unmounted, so the shell only ever sees the reload the reactivation starts.
    await setHostedViewActive(false)
    await setHostedViewActive(true)
    await loadDocument()
    await handle(subscribeRequest('B', 'Y'))

    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.subscribe).toHaveBeenCalledTimes(2)
    expect(errorFor(harness.messages, 'B')).toEqual([])
  })

  it('re-subscribes after the page reloads itself in place', async () => {
    await mount()
    await loadDocument()
    await handle(subscribeRequest('A', 'Z'))

    // What the route error boundary's recovery button does: same view, same session, new document.
    // The duplicate `loading` is what the shell really posts — once for the reload it starts and
    // once for the navigation the page started — and the pair is still a single new page.
    await emitLoadState({ state: 'loading' })
    await emitLoadState({ state: 'loading' })
    await emitLoadState({ state: 'loaded' })
    await handle(subscribeRequest('B', 'Y'))

    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.created).toBe(2)
    expect(errorFor(harness.messages, 'B')).toEqual([])
  })

  it('never retires the broker that is about to serve the first document', async () => {
    await mount()
    const live = harness.brokerRef.current

    // The shell posts `loading` for the first load too, and more than once for the same load. A
    // page that has not loaded yet has nothing to retire, and retiring here would drop the grants
    // out from under the document that is loading.
    await emitLoadState({ state: 'loading' })
    await emitLoadState({ state: 'loading' })
    await emitLoadState({ state: 'loaded' })
    await handle(subscribeRequest('A', 'Z'))

    expect(harness.unsubscribe).not.toHaveBeenCalled()
    expect(harness.created).toBe(1)
    expect(harness.brokerRef.current).toBe(live)
    expect(errorFor(harness.messages, 'A')).toEqual([])
  })

  it('retires every replacement when native loading and loaded events are batched', async () => {
    await mount()
    await loadDocument()
    await handle(subscribeRequest('A', 'Z'))

    const shell = renderer!.root.findByType('MobileWebShellView' as never)
    await act(async () => {
      shell.props.onLoadState({ nativeEvent: { state: 'loading' } })
      shell.props.onLoadState({ nativeEvent: { state: 'loaded' } })
    })
    await handle(subscribeRequest('B', 'Y'))
    await loadDocument()
    await handle(subscribeRequest('C', 'X'))

    expect(harness.created).toBe(3)
    expect(harness.unsubscribe).toHaveBeenCalledTimes(2)
    expect(harness.subscribe).toHaveBeenCalledTimes(3)
    expect(errorFor(harness.messages, 'C')).toEqual([])
  })

  it('is the wiring the hosted screen uses', () => {
    // The harness above composes the two seams by hand; this pins the screen to the same pair.
    const source = readFileSync(
      fileURLToPath(new URL('../../app/hybrid.tsx', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('documentEpoch: pageDocument.epoch')
    expect(source).toContain('onDocumentLoadStarted={pageDocument.onLoadStart}')
    expect(source).toContain('pageDocument.onLoaded()')
  })

  async function mount(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(harness.Shell, { hostedViewActive: true }))
    })
  }

  async function setHostedViewActive(hostedViewActive: boolean): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(harness.Shell, { hostedViewActive }))
    })
  }

  async function loadDocument(): Promise<void> {
    await emitLoadState({ state: 'loading' })
    await emitLoadState({ state: 'loaded' })
  }

  async function emitLoadState(nativeEvent: { state: string; reason?: string }): Promise<void> {
    const shell = renderer!.root.findByType('MobileWebShellView' as never)
    await act(async () => {
      shell.props.onLoadState({ nativeEvent })
    })
  }

  async function handle(message: MobileWebBridgePageMessage): Promise<void> {
    await act(async () => {
      await harness.brokerRef.current?.handle(message)
    })
  }
})

function createHarness() {
  const messages: MobileWebBridgeShellMessage[] = []
  const unsubscribe = vi.fn()
  const subscribe = vi.fn<RpcClient['subscribe']>(() => unsubscribe)
  const client = {
    sendRequest: vi.fn<RpcClient['sendRequest']>(),
    subscribe,
    sendTerminalBinaryFrame: vi.fn(() => true)
  } as unknown as RpcClient
  const brokerRef: { current: MobileWebCapabilityBroker | null } = { current: null }
  // Stable like hybrid.tsx's useCallback: a fresh identity per render would retire the broker on
  // every render and hide whether the document epoch is doing the work.
  const createBroker = (page: { sessionId: string; buildId: string }) => {
    state.created += 1
    return new MobileWebCapabilityBroker({
      context: { shellSessionId: page.sessionId, buildId: page.buildId },
      getClient: () => client,
      isConnected: () => true,
      isActive: () => true,
      postMessage: (message) => void messages.push(message),
      nativeAuthority: {
        clipboardAvailability: vi.fn(),
        hapticFeedback: vi.fn(),
        clipboardWrite: vi.fn(),
        openExternal: vi.fn(),
        terminalPreferences: vi.fn(),
        terminalTextScaleUpdate: vi.fn()
      },
      terminalClientId: 'device-token',
      randomBytes: (length) => new Uint8Array(length).fill(1)
    })
  }
  const state = {
    messages,
    subscribe,
    unsubscribe,
    brokerRef,
    created: 0,
    Shell: undefined as unknown as FunctionComponent<{ hostedViewActive: boolean }>
  }
  state.Shell = ({ hostedViewActive }) => {
    const healthDeadlineRef = useRef(new MobileWebHealthDeadline(10_000))
    const routeHandoffRef = useRef(new MobileWebNativeRouteHandoff())
    const pageDocument = useMobileWebPageDocument({
      sessionId: SESSION_ID,
      viewEpoch: 0,
      healthDeadlineRef,
      routeHandoffRef
    })
    useMobileWebCapabilityBroker({
      brokerRef,
      sessionId: SESSION_ID,
      buildId: BUILD_ID,
      viewEpoch: 0,
      documentEpoch: pageDocument.epoch,
      createBroker,
      onBrokerReady: noop,
      onBrokerSessionChange: noop
    })
    return createElement(MobileWebHybridShellPresentation, {
      viewRef: { current: null },
      selectedHost: { id: 'host-1', name: 'Desk', publicKeyB64: 'k' } as never,
      session: { sessionId: SESSION_ID, buildId: BUILD_ID } as never,
      viewEpoch: 0,
      packageLoading: false,
      packageProgress: undefined,
      packageWarning: undefined,
      hostedViewActive,
      onBack: noop,
      onShowHosts: noop,
      onRetryRecovery: noop,
      onUsePrevious: noop,
      onClearCache: noop,
      onRecoveryFailure: noop,
      onBridgeMessage: noop,
      onDocumentLoadStarted: pageDocument.onLoadStart,
      onPageLoaded: pageDocument.onLoaded,
      onLoadFailed: noop,
      onNavigationBlocked: noop,
      onProcessTerminated: noop
    })
  }
  return state
}

function subscribeRequest(
  requestId: string,
  subscriptionId: string
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    shellSessionId: SESSION_ID,
    buildId: BUILD_ID,
    type: 'request',
    mode: 'subscription',
    requestId: requestId.repeat(22),
    subscriptionId: subscriptionId.repeat(22),
    capability: 'workspace',
    operation: 'subscribe',
    payload: {}
  }
}

function errorFor(messages: MobileWebBridgeShellMessage[], requestId: string) {
  return messages.flatMap((message) =>
    message.type === 'response' &&
    message.requestId === requestId.repeat(22) &&
    message.status === 'error'
      ? [message.error]
      : []
  )
}
