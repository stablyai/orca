import { createElement, type FunctionComponent } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import {
  useMobileWebCapabilityBroker,
  type MobileWebBrokerPageIdentity
} from './use-mobile-web-capability-broker'

const CONTEXT = { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) }

describe('useMobileWebCapabilityBroker', () => {
  let renderer: ReactTestRenderer | null = null
  let harness: ReturnType<typeof createHarness>

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('caps a single page at one concurrent workspace subscription', async () => {
    await mount(0)

    await handle(subscribeRequest('A', 'Z'))
    await handle(subscribeRequest('B', 'Y'))

    expect(harness.subscribe).toHaveBeenCalledOnce()
    expect(errorFor(harness.messages, 'B')).toEqual([{ code: 'rate_limited', retryable: true }])
  })

  it('retires the previous page subscriptions when the view epoch restarts the document', async () => {
    await mount(0)
    await handle(subscribeRequest('A', 'Z'))
    const restartedBroker = harness.brokerRef.current

    await act(async () => {
      renderer?.update(createElement(harness.Harness, { viewEpoch: 1 }))
    })

    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.created).toBe(2)
    expect(harness.brokerRef.current).not.toBe(restartedBroker)

    await handle(subscribeRequest('B', 'Y'))

    expect(harness.subscribe).toHaveBeenCalledTimes(2)
    expect(errorFor(harness.messages, 'B')).toEqual([])
  })

  it('retires the previous page subscriptions when the document is replaced in place', async () => {
    await mount(0)
    await handle(subscribeRequest('A', 'Z'))

    await act(async () => {
      renderer?.update(createElement(harness.Harness, { viewEpoch: 0, documentEpoch: 1 }))
    })
    await handle(subscribeRequest('B', 'Y'))

    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.subscribe).toHaveBeenCalledTimes(2)
    expect(errorFor(harness.messages, 'B')).toEqual([])
  })

  it('retires the broker on demand so an in-place reload cannot inherit it', async () => {
    await mount(0)
    await handle(subscribeRequest('A', 'Z'))

    act(() => harness.retireBroker?.())

    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.brokerRef.current).toBeNull()
    expect(harness.brokerSessionId).toBeUndefined()
  })

  async function mount(viewEpoch: number): Promise<void> {
    await act(async () => {
      renderer = create(createElement(harness.Harness, { viewEpoch }))
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
  const state = {
    messages,
    subscribe,
    unsubscribe,
    brokerRef,
    created: 0,
    brokerSessionId: undefined as string | undefined,
    retireBroker: undefined as (() => void) | undefined,
    Harness: undefined as unknown as FunctionComponent<{
      viewEpoch: number
      documentEpoch?: number
    }>
  }
  const createBroker = (page: MobileWebBrokerPageIdentity): MobileWebCapabilityBroker => {
    state.created += 1
    return new MobileWebCapabilityBroker({
      context: { shellSessionId: page.sessionId, buildId: page.buildId },
      getClient: () => client,
      isConnected: () => true,
      isActive: () => true,
      postMessage: (message) => messages.push(message),
      nativeAuthority: {
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
  const onBrokerReady = (): void => {}
  const onBrokerSessionChange = (sessionId: string | undefined): void => {
    state.brokerSessionId = sessionId
  }
  state.Harness = ({ viewEpoch, documentEpoch = 0 }) => {
    const lifecycle = useMobileWebCapabilityBroker({
      brokerRef,
      sessionId: CONTEXT.shellSessionId,
      buildId: CONTEXT.buildId,
      viewEpoch,
      documentEpoch,
      createBroker,
      onBrokerReady,
      onBrokerSessionChange
    })
    state.retireBroker = lifecycle.retireBroker
    return null
  }
  return state
}

function subscribeRequest(
  requestId: string,
  subscriptionId: string
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
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
