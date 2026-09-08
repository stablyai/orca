import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) }
const REQUEST_ID = 'Q'.repeat(22)
const SUBSCRIPTION_ID = 'S'.repeat(22)

const KNOWN_TAB = {
  id: 'tab-1',
  title: 'Terminal',
  isActive: true,
  type: 'terminal',
  status: 'ready'
}

function hostSnapshot(): Record<string, unknown> {
  return {
    workspaceId: 'workspace-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 4,
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    tabs: [KNOWN_TAB],
    truncated: false
  }
}

function envelope() {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION as typeof MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId
  }
}

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const ids = [REQUEST_ID, SUBSCRIPTION_ID]
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: (['subscribe', 'snapshot'] as const).map((operation) => ({
      capability: 'workspace' as const,
      operation: operation === 'subscribe' ? 'hostSubscribe' : 'hostRequest',
      limits: {
        maxRequestBytes: 1024,
        maxResponseBytes: 128 * 1024,
        maxConcurrent: 2,
        rateCapacity: 4,
        rateRefillPerSecond: 1
      }
    })),
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => ids.shift() ?? 'Z'.repeat(22)
  })
  return { client, messages }
}

function subscriptionAck(): MobileWebBridgeShellMessage {
  return {
    ...envelope(),
    type: 'response',
    requestId: REQUEST_ID,
    status: 'success',
    payload: null
  }
}

describe('host-owned session payloads', () => {
  it('delivers a Desktop snapshot through the generic subscription', async () => {
    const { client } = createHarness()
    const onEvent = vi.fn()
    const onError = vi.fn()
    const subscription = client.sessionSubscribe({ workspaceId: 'workspace-1' }, onEvent, onError)
    client.receive(subscriptionAck())
    await subscription.ready

    client.receive({
      ...envelope(),
      type: 'event',
      subscriptionId: SUBSCRIPTION_ID,
      sequence: 0,
      payload: { type: 'snapshot', snapshot: hostSnapshot() }
    })

    expect(onError).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 4,
      activeTabId: 'tab-1',
      activeTabType: 'terminal',
      tabs: [KNOWN_TAB],
      truncated: false
    })
  })

  it('reads a Desktop snapshot through the generic unary route', async () => {
    const { client } = createHarness()
    const pending = client.sessionSnapshot({ workspaceId: 'workspace-1' })

    client.receive({
      ...envelope(),
      type: 'response',
      requestId: REQUEST_ID,
      status: 'success',
      payload: hostSnapshot()
    })

    await expect(pending).resolves.toMatchObject({ activeTabType: 'terminal', tabs: [KNOWN_TAB] })
  })

  it('still fails a snapshot whose known fields are wrong', async () => {
    const { client } = createHarness()
    const pending = client.sessionSnapshot({ workspaceId: 'workspace-1' })

    client.receive({
      ...envelope(),
      type: 'response',
      requestId: REQUEST_ID,
      status: 'success',
      payload: { ...hostSnapshot(), truncated: 'no' }
    })

    await expect(pending).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })
})
