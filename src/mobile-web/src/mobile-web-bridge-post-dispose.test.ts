import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import type { MobileWebBridgeClient as MobileWebBridgeClientType } from './mobile-web-bridge-client'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'
import { MobileWebTerminalRequestScheduler } from './mobile-web-terminal-request-scheduler'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const REQUEST_ID = 'Q'.repeat(22)
const SUBSCRIPTION_ID = 'S'.repeat(22)

describe('after dispose', () => {
  it('drops a subscription event that arrives after the bridge client is disposed', async () => {
    const harness = createHarness()
    const subscription = harness.client.sessionSubscribe(
      { workspaceId: 'workspace-1' },
      harness.onEvent,
      harness.onError
    )
    harness.client.receive(subscriptionAck())
    await subscription.ready
    harness.client.receive(sessionEvent(0))
    expect(harness.onEvent).toHaveBeenCalledTimes(1)

    harness.client.dispose()
    harness.client.receive(sessionEvent(1))

    expect(harness.onEvent).toHaveBeenCalledTimes(1)
    expect(harness.onError).not.toHaveBeenCalled()
  })

  it('never resolves a one-shot response delivered after dispose', async () => {
    const harness = createHarness()
    const settled = vi.fn()
    const request = harness.client.workspaceSnapshot({ limit: 10 })
    void request.then(
      () => settled('resolved'),
      (error: { code: string }) => settled(error.code)
    )

    harness.client.dispose()
    harness.client.receive(
      snapshotResponse({ status: 'success', payload: { workspaces: [], truncated: false } })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(settled).toHaveBeenCalledExactlyOnceWith('cancelled')
  })

  it('posts one cancel per subscription however many times dispose runs', async () => {
    const harness = createHarness()
    const subscription = harness.client.sessionSubscribe(
      { workspaceId: 'workspace-1' },
      harness.onEvent,
      harness.onError
    )
    harness.client.receive(subscriptionAck())
    await subscription.ready

    harness.client.dispose()
    harness.client.dispose()
    subscription.unsubscribe()

    expect(harness.messages.filter((message) => message.type === 'cancel')).toEqual([
      expect.objectContaining({ type: 'cancel', target: 'subscription', id: SUBSCRIPTION_ID })
    ])
  })

  it('keeps a disposed terminal scheduler from reporting a late failure', async () => {
    const rejection = deferred<null>()
    const terminalRequest = vi.fn(() => rejection.promise)
    const onError = vi.fn()
    const client = {
      terminalRequest,
      terminalDeviceInputRequest: vi.fn()
    } as unknown as MobileWebBridgeClientType
    const scheduler = new MobileWebTerminalRequestScheduler(client, 'T'.repeat(22), onError)
    scheduler.markHostReady(true)

    const inFlight = scheduler.sendInputAsync('input', 'YQ==')
    await vi.waitFor(() => expect(terminalRequest).toHaveBeenCalledTimes(1))
    scheduler.dispose()
    rejection.reject(new Error('socket closed'))

    await expect(inFlight).resolves.toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })
})

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const ids = [REQUEST_ID, SUBSCRIPTION_ID]
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
      {
        capability: 'session',
        operation: 'subscribe',
        limits: {
          maxRequestBytes: 1024,
          maxResponseBytes: 128 * 1024,
          maxConcurrent: 2,
          rateCapacity: 4,
          rateRefillPerSecond: 1
        }
      },
      {
        capability: 'workspace',
        operation: 'snapshot',
        limits: {
          maxRequestBytes: 1024,
          maxResponseBytes: 128 * 1024,
          maxConcurrent: 2,
          rateCapacity: 4,
          rateRefillPerSecond: 1
        }
      }
    ],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => ids.shift() ?? 'Z'.repeat(22)
  })
  return { client, messages, onEvent: vi.fn(), onError: vi.fn() }
}

function subscriptionAck(): Extract<MobileWebBridgeShellMessage, { type: 'response' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: REQUEST_ID,
    status: 'success',
    payload: null
  }
}

function snapshotResponse(value: {
  status: 'success'
  payload: unknown
}): Extract<MobileWebBridgeShellMessage, { type: 'response' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: REQUEST_ID,
    ...value
  }
}

function sessionEvent(sequence: number): Extract<MobileWebBridgeShellMessage, { type: 'event' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    subscriptionId: SUBSCRIPTION_ID,
    sequence,
    payload: {
      workspaceId: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: sequence + 1,
      activeTabId: null,
      activeTabType: null,
      tabs: [],
      truncated: false
    }
  }
}

function deferred<T>(): { promise: Promise<T>; reject: (error: Error) => void } {
  let rejectPromise = (_error: Error): void => {}
  const promise = new Promise<T>((_resolve, reject) => {
    rejectPromise = reject
  })
  return { promise, reject: rejectPromise }
}
