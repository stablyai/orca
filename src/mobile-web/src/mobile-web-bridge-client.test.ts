import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient, MobileWebBridgeClientError } from './mobile-web-bridge-client'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const REQUEST_ID = 'R'.repeat(22)

afterEach(() => vi.useRealTimers())

describe('mobile web bridge client', () => {
  it('posts an exact typed request and resolves a schema-checked response', async () => {
    const harness = createHarness()
    const result = harness.client.workspaceSnapshot({ limit: 10 })
    harness.client.receive(
      response({
        status: 'success',
        payload: { workspaces: [], truncated: false }
      })
    )

    await expect(result).resolves.toEqual({ workspaces: [], truncated: false })
    expect(harness.messages[0]).toEqual({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'request',
      mode: 'once',
      shellSessionId: CONTEXT.shellSessionId,
      buildId: CONTEXT.buildId,
      requestId: REQUEST_ID,
      capability: 'workspace',
      operation: 'snapshot',
      payload: { limit: 10 }
    })
  })

  it('fails closed for ungranted operations and malformed success payloads', async () => {
    const harness = createHarness()
    await expect(harness.client.native.hapticSelection()).rejects.toMatchObject({
      code: 'unsupported_capability',
      retryable: false
    })

    const result = harness.client.workspaceSnapshot({ limit: 10 })
    harness.client.receive(response({ status: 'success', payload: { workspaces: 'invalid' } }))
    await expect(result).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('preserves stable shell error codes without accepting an error message', async () => {
    const harness = createHarness()
    const result = harness.client.workspaceSnapshot({ limit: 10 })
    harness.client.receive(
      response({ status: 'error', error: { code: 'not_connected', retryable: true } })
    )

    await expect(result).rejects.toEqual(new MobileWebBridgeClientError('not_connected', true))
  })

  it('requests host gates through the existing capability grant', async () => {
    const messages: MobileWebBridgePageMessage[] = []
    const client = new MobileWebBridgeClient({
      context: CONTEXT,
      grants: [
        {
          capability: 'session',
          operation: 'capabilities',
          limits: {
            maxRequestBytes: 256,
            maxResponseBytes: 64 * 1024,
            maxConcurrent: 1,
            rateCapacity: 4,
            rateRefillPerSecond: 1
          }
        }
      ],
      postMessage: (message) => {
        messages.push(message)
        return true
      },
      createRequestId: () => REQUEST_ID
    })
    const result = client.sessionHostGates({ includeHostGates: true })
    client.receive(
      response({
        status: 'success',
        payload: { hostCapabilities: ['aiVault.v1'], floatingWorkspaceEnabled: true }
      })
    )

    await expect(result).resolves.toEqual({
      hostCapabilities: ['aiVault.v1'],
      floatingWorkspaceEnabled: true
    })
    expect(messages[0]).toMatchObject({
      capability: 'session',
      operation: 'capabilities',
      payload: { includeHostGates: true }
    })
  })

  it('times out with cancellation and cancels all pending work on dispose', async () => {
    vi.useFakeTimers()
    const timeoutHarness = createHarness({ timeout: 100 })
    const timedOut = timeoutHarness.client.workspaceSnapshot({ limit: 10 })
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(100)
    await timeoutExpectation
    expect(timeoutHarness.messages.at(-1)).toMatchObject({
      type: 'cancel',
      target: 'request',
      id: REQUEST_ID
    })

    const disposeHarness = createHarness()
    const disposed = disposeHarness.client.workspaceSnapshot({ limit: 10 })
    disposeHarness.client.dispose()
    await expect(disposed).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('cancels one-shot file work through an AbortSignal', async () => {
    const messages: MobileWebBridgePageMessage[] = []
    const client = new MobileWebBridgeClient({
      context: CONTEXT,
      grants: [
        {
          capability: 'file',
          operation: 'directory',
          limits: {
            maxRequestBytes: 4096,
            maxResponseBytes: 64 * 1024,
            maxConcurrent: 2,
            rateCapacity: 12,
            rateRefillPerSecond: 4
          }
        }
      ],
      postMessage: (message) => {
        messages.push(message)
        return true
      },
      createRequestId: () => REQUEST_ID
    })
    const controller = new AbortController()
    const result = client.fileDirectory(
      { workspaceId: 'workspace-1', relativePath: '', limit: 128 },
      { signal: controller.signal }
    )

    controller.abort()

    await expect(result).rejects.toEqual(new MobileWebBridgeClientError('cancelled', false))
    expect(messages.at(-1)).toMatchObject({
      type: 'cancel',
      target: 'request',
      id: REQUEST_ID
    })
  })

  it('turns invalid typed payloads and request ID exhaustion into stable rejections', async () => {
    const invalidPayloadHarness = createHarness()
    await expect(
      invalidPayloadHarness.client.workspaceSnapshot({ limit: 0 })
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false })

    const collisionHarness = createHarness()
    const first = collisionHarness.client.workspaceSnapshot({ limit: 10 })
    await expect(collisionHarness.client.workspaceSnapshot({ limit: 10 })).rejects.toMatchObject({
      code: 'conflict',
      retryable: true
    })
    collisionHarness.client.dispose()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('orders typed session events and cancels a subscription after a sequence gap', async () => {
    const messages: MobileWebBridgePageMessage[] = []
    const ids = ['Q'.repeat(22), 'S'.repeat(22)]
    const onEvent = vi.fn()
    const onError = vi.fn()
    const client = new MobileWebBridgeClient({
      context: CONTEXT,
      grants: [
        {
          capability: 'session',
          operation: 'subscribe',
          limits: {
            maxRequestBytes: 1024,
            maxResponseBytes: 1024,
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

    const subscription = client.sessionSubscribe({ workspaceId: 'workspace-1' }, onEvent, onError)
    expect(messages[0]).toMatchObject({
      type: 'request',
      mode: 'subscription',
      requestId: 'Q'.repeat(22),
      subscriptionId: 'S'.repeat(22),
      capability: 'session',
      operation: 'subscribe'
    })
    client.receive(subscriptionResponse())
    await expect(subscription.ready).resolves.toBeUndefined()

    client.receive(subscriptionEvent(0, 1))
    client.receive(subscriptionEvent(0, 1))
    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ snapshotVersion: 1 }))

    client.receive(subscriptionEvent(2, 3))
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_message', retryable: true })
    )
    expect(messages.at(-1)).toMatchObject({
      type: 'cancel',
      target: 'subscription',
      id: 'S'.repeat(22)
    })
  })

  it('cancels an active session subscription when its shell client is disposed', async () => {
    const messages: MobileWebBridgePageMessage[] = []
    const ids = ['Q'.repeat(22), 'S'.repeat(22)]
    const client = new MobileWebBridgeClient({
      context: CONTEXT,
      grants: [sessionSubscriptionGrant()],
      postMessage: (message) => {
        messages.push(message)
        return true
      },
      createRequestId: () => ids.shift() ?? 'Z'.repeat(22)
    })
    const subscription = client.sessionSubscribe({ workspaceId: 'workspace-1' }, vi.fn(), vi.fn())
    client.receive(subscriptionResponse())
    await subscription.ready

    client.dispose()

    expect(messages.at(-1)).toMatchObject({
      type: 'cancel',
      target: 'subscription',
      id: 'S'.repeat(22)
    })
  })

  it('retires a session subscription on a cross-workspace event', async () => {
    const messages: MobileWebBridgePageMessage[] = []
    const ids = ['Q'.repeat(22), 'S'.repeat(22)]
    const onEvent = vi.fn()
    const onError = vi.fn()
    const client = new MobileWebBridgeClient({
      context: CONTEXT,
      grants: [sessionSubscriptionGrant()],
      postMessage: (message) => {
        messages.push(message)
        return true
      },
      createRequestId: () => ids.shift() ?? 'Z'.repeat(22)
    })
    const subscription = client.sessionSubscribe({ workspaceId: 'workspace-1' }, onEvent, onError)
    client.receive(subscriptionResponse())
    await subscription.ready

    client.receive(subscriptionEvent(0, 1, 'workspace-2'))

    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_message', retryable: false })
    )
    expect(messages.at(-1)).toMatchObject({
      type: 'cancel',
      target: 'subscription',
      id: 'S'.repeat(22)
    })
  })
})

function createHarness(options: { timeout?: number } = {}) {
  const messages: MobileWebBridgePageMessage[] = []
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
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
    createRequestId: () => REQUEST_ID,
    requestTimeoutMs: options.timeout
  })
  return { client, messages }
}

function response(
  value:
    | { status: 'success'; payload: unknown }
    | {
        status: 'error'
        error: { code: 'not_connected'; retryable: boolean }
      }
): Extract<MobileWebBridgeShellMessage, { type: 'response' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: REQUEST_ID,
    ...value
  }
}

function subscriptionResponse(): Extract<MobileWebBridgeShellMessage, { type: 'response' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: 'Q'.repeat(22),
    status: 'success',
    payload: null
  }
}

function subscriptionEvent(
  sequence: number,
  snapshotVersion: number,
  workspaceId = 'workspace-1'
): Extract<MobileWebBridgeShellMessage, { type: 'event' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    subscriptionId: 'S'.repeat(22),
    sequence,
    payload: {
      workspaceId,
      publicationEpoch: 'epoch-1',
      snapshotVersion,
      activeTabId: null,
      activeTabType: null,
      tabs: [],
      truncated: false
    }
  }
}

function sessionSubscriptionGrant() {
  return {
    capability: 'session' as const,
    operation: 'subscribe',
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: 128 * 1024,
      maxConcurrent: 2,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  }
}
