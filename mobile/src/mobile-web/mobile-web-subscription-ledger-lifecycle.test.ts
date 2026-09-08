import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeShellMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebSubscriptionClosure } from './mobile-web-subscription-closure'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import { MobileWebBrokerMessageSender } from './mobile-web-broker-message-sender'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import {
  createMobileWebBrokerFixture,
  MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'

function randomBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(4)
}

function bridgeId(index: number): string {
  return index.toString().padStart(22, 'Q')
}

function stubClient(unsubscribe: () => void): RpcClient {
  return { subscribe: vi.fn(() => unsubscribe) } as unknown as RpcClient
}

describe('subscription ledger teardown', () => {
  it('retires every live subscription without a closure when the whole shell goes away', () => {
    const unsubscribe = vi.fn()
    const postClosed = vi.fn()
    const ledger = new MobileWebHostSubscriptions({
      workspaceAuthority: new MobileWebWorkspaceAuthority(randomBytes),
      isActive: () => true,
      postEvent: async () => {},
      postClosed
    })
    ledger.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      payload: { method: 'accounts.subscribe', params: {} },
      client: stubClient(unsubscribe),
      isActive: () => true
    })

    ledger.dispose()

    // The page document is being torn down with the shell, so a closure frame has no reader.
    expect(postClosed).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(ledger.cancel('subscription-1')).toBeNull()
    expect(ledger.countForOperation('workspace.hostSubscribe')).toBe(0)
  })

  it('tells the page why each subscription ended when only the host feed goes away', () => {
    const unsubscribe = vi.fn()
    const closures: [string, MobileWebSubscriptionClosure][] = []
    const ledger = new MobileWebHostSubscriptions({
      workspaceAuthority: new MobileWebWorkspaceAuthority(randomBytes),
      isActive: () => true,
      postEvent: async () => {},
      postClosed: (subscriptionId, closure) => closures.push([subscriptionId, closure])
    })
    for (const subscriptionId of ['subscription-1', 'subscription-2']) {
      ledger.start({
        requestId: subscriptionId,
        subscriptionId,
        payload: { method: 'accounts.subscribe', params: {} },
        client: stubClient(unsubscribe),
        isActive: () => true
      })
    }

    ledger.closeAll({ code: 'unavailable', retryable: true })

    expect(closures).toEqual([
      ['subscription-1', { code: 'unavailable', retryable: true }],
      ['subscription-2', { code: 'unavailable', retryable: true }]
    ])
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(ledger.countForOperation('workspace.hostSubscribe')).toBe(0)
  })

  it('posts host-feed closures through the broker message sender', () => {
    const messages: MobileWebBridgeShellMessage[] = []
    const sender = new MobileWebBrokerMessageSender({
      context: MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT,
      isActive: () => true,
      postMessage: (message) => {
        messages.push(message)
      }
    })
    const workspaceAuthority = new MobileWebWorkspaceAuthority(randomBytes)
    workspaceAuthority.synchronize(['host-workspace'])
    const subscriptions = new MobileWebHostSubscriptions({
      ...sender.subscriptionPosts(),
      workspaceAuthority
    })
    const client = stubClient(() => {})
    subscriptions.start({
      requestId: 'r2',
      subscriptionId: 'host-1',
      payload: { method: 'mobileWeb.workspace.subscribe', params: {} },
      client,
      isActive: () => true
    })

    subscriptions.closeAll({ code: 'unavailable', retryable: true })

    expect(messages.map((message) => message.type)).toEqual(['subscriptionClosed'])
    expect(subscriptions.cancel('host-1')).toBeNull()
  })

  it('keeps a bare ledger cancel silent so a page-driven cancel gets no closure echo', () => {
    const postClosed = vi.fn()
    const ledger = new MobileWebHostSubscriptions({
      workspaceAuthority: new MobileWebWorkspaceAuthority(randomBytes),
      isActive: () => true,
      postEvent: async () => {},
      postClosed
    })
    ledger.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      payload: { method: 'accounts.subscribe', params: {} },
      client: stubClient(() => {}),
      isActive: () => true
    })

    expect(ledger.cancel('subscription-1')).toBe('request-1')
    expect(postClosed).not.toHaveBeenCalled()
  })
})

describe('broker client lifecycle', () => {
  it('closes live subscriptions toward the page when the RPC client is replaced', async () => {
    const client = stubClient(() => {})
    const { broker, messages } = createMobileWebBrokerFixture({ getClient: () => client })
    await broker.handle(accountSubscribe())
    messages.length = 0

    broker.replaceClient(null)

    expect(messages).toEqual([
      expect.objectContaining({
        type: 'subscriptionClosed',
        subscriptionId: bridgeId(2),
        error: { code: 'unavailable', retryable: true }
      })
    ])
  })

  it('stays silent toward the page when the broker itself is disposed', async () => {
    const client = stubClient(() => {})
    const { broker, messages } = createMobileWebBrokerFixture({ getClient: () => client })
    await broker.handle(accountSubscribe())
    messages.length = 0

    broker.dispose()

    expect(messages).toEqual([])
  })
})

function accountSubscribe(): ReturnType<typeof mobileWebBridgeRequestMessage> {
  return mobileWebBridgeRequestMessage({
    requestId: bridgeId(1),
    subscriptionId: bridgeId(2),
    capability: 'workspace',
    operation: 'hostSubscribe',
    payload: { method: 'accounts.subscribe', params: {} }
  })
}
