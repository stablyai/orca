/**
 * The bridge had seven shell -> page frames and none of them closed a subscription. Once the
 * subscribe response said `success`, the only frame left was `event`, so every shell-side failure
 * after that point was unrepresentable: the page kept a live entry with no timeout and no
 * heartbeat, and the screen froze on its last value ("Loading tabs" forever, for session tabs).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgeShellMessage,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) }
const REQUEST_ID = 'Q'.repeat(22)
const SUBSCRIPTION_ID = 'S'.repeat(22)

function envelope() {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION as typeof MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId
  }
}

function subscriptionResponse(): MobileWebBridgeShellMessage {
  return {
    ...envelope(),
    type: 'response',
    requestId: REQUEST_ID,
    status: 'success',
    payload: null
  }
}

function subscriptionClosed(
  code: 'unavailable' | 'too_large',
  retryable: boolean
): MobileWebBridgeShellMessage {
  return {
    ...envelope(),
    type: 'subscriptionClosed',
    subscriptionId: SUBSCRIPTION_ID,
    error: { code, retryable }
  }
}

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const ids = [REQUEST_ID, SUBSCRIPTION_ID]
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
      {
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
    ],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => ids.shift() ?? 'Z'.repeat(22)
  })
  return { client, messages }
}

describe('subscriptionClosed', () => {
  it('surfaces a late shell failure through onError and retires the page entry', async () => {
    const { client, messages } = createHarness()
    const onEvent = vi.fn()
    const onError = vi.fn()
    const subscription = client.sessionSubscribe({ workspaceId: 'workspace-1' }, onEvent, onError)
    client.receive(subscriptionResponse())
    await subscription.ready

    client.receive(subscriptionClosed('unavailable', true))

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unavailable', retryable: true })
    )
    expect(messages.at(-1)).toMatchObject({
      type: 'cancel',
      target: 'subscription',
      id: SUBSCRIPTION_ID
    })
    // The entry is gone, so a duplicate close cannot fire onError twice.
    client.receive(subscriptionClosed('unavailable', true))
    expect(onError).toHaveBeenCalledOnce()
  })

  it('carries retryable so a caller can tell a transient close from a permanent one', async () => {
    const { client } = createHarness()
    const onError = vi.fn()
    const subscription = client.sessionSubscribe({ workspaceId: 'workspace-1' }, vi.fn(), onError)
    client.receive(subscriptionResponse())
    await subscription.ready

    client.receive(subscriptionClosed('too_large', false))

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'too_large', retryable: false })
    )
  })

  it('parses on a current page and is ignored, not fatal, on one that predates it', () => {
    const context = { shellSessionId: CONTEXT.shellSessionId, buildId: CONTEXT.buildId }
    expect(
      parseMobileWebBridgeShellMessage(
        JSON.stringify(subscriptionClosed('unavailable', true)),
        context
      ).ok
    ).toBe(true)
    // An older page's decoder has no branch for the type, which is the same shape as this parse
    // failure: `native-shell-channel` returns on `!ok` rather than tearing the session down.
    expect(
      parseMobileWebBridgeShellMessage(
        JSON.stringify({ ...envelope(), type: 'somethingNewer', subscriptionId: SUBSCRIPTION_ID }),
        context
      ).ok
    ).toBe(false)
  })
})
