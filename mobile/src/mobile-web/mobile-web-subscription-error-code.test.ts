import { sessionHostFixture } from './mobile-web-session-host-fixture'
import { describe, expect, it, vi } from 'vitest'
import type {
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import {
  isRetryableMobileWebBridgeError,
  mobileWebBridgeErrorCode
} from './mobile-web-broker-error'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const randomBytes = (length: number): Uint8Array => new Uint8Array(length).fill(4)

function stubClient(): RpcClient {
  return { subscribe: vi.fn(() => () => {}) } as unknown as RpcClient
}

// Each ledger raises its own subscription code; the bridge converter must carry every one of them.
function ledgerStarters(): { name: string; start: (subscriptionId: string) => void }[] {
  const postEvent = async (): Promise<void> => {}
  const isActive = (): boolean => true
  const client = stubClient()
  const workspaceAuthority = new MobileWebWorkspaceAuthority(randomBytes)
  workspaceAuthority.synchronize(['host-workspace'])

  const postClosed = (): void => {}
  const hostFeed = new MobileWebHostSubscriptions({
    isActive,
    workspaceAuthority,
    postEvent,
    postClosed
  })
  return [
    {
      name: 'host',
      start: (subscriptionId) =>
        hostFeed.start({
          requestId: 'r',
          subscriptionId,
          payload: { method: 'accounts.subscribe', params: {} },
          client,
          isActive
        })
    }
  ]
}

describe('subscription ledger error codes reach the page unchanged', () => {
  for (const ledger of ledgerStarters()) {
    it(`carries the ${ledger.name} ledger's invalid_request through the bridge converter`, () => {
      ledger.start('subscription-1')
      let thrown: unknown
      try {
        ledger.start('subscription-1')
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect(mobileWebBridgeErrorCode(thrown)).toBe('invalid_request')
      expect(isRetryableMobileWebBridgeError(mobileWebBridgeErrorCode(thrown))).toBe(false)
    })
  }

  it('reports a duplicate subscription ID evicted from the replay ring as invalid_request', async () => {
    const sendRequest = vi.fn()
    const client = sessionHostFixture({
      subscribe: vi.fn(() => () => {}),
      sendRequest
    } as unknown as RpcClient)
    const messages: MobileWebBridgeShellMessage[] = []
    const { broker } = createMobileWebBrokerFixture({
      getClient: () => client,
      postMessage: (message) => {
        messages.push(message)
      }
    })
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { worktrees: [{ worktreeId: 'workspace-1', repoId: 'repo-1' }] }
    })
    await broker.handle(
      mobileWebBridgeRequestMessage({
        requestId: bridgeId(1),
        capability: 'workspace',
        operation: 'snapshot',
        payload: { limit: 1 }
      })
    )
    const live = bridgeId(2)
    await broker.handle(sessionSubscribe(bridgeId(3), live))
    expect(lastCode(messages)).toBeUndefined()

    // The replay ring is bounded and capability-agnostic, so a live session ID ages out of it
    // behind unrelated subscribe traffic while the session ledger still holds it.
    for (let index = 0; index <= 129; index += 1) {
      await broker.handle(
        mobileWebBridgeRequestMessage({
          requestId: bridgeId(100 + index),
          subscriptionId: bridgeId(100 + index),
          capability: 'workspace',
          operation: 'subscribe',
          payload: {}
        }) as Extract<MobileWebBridgePageMessage, { type: 'request' }>
      )
    }
    messages.length = 0
    await broker.handle(sessionSubscribe(bridgeId(9), live))

    expect(messages.at(-1)).toMatchObject({
      type: 'response',
      status: 'error',
      error: { code: 'invalid_request', retryable: false }
    })
  })
})

function sessionSubscribe(
  requestId: string,
  subscriptionId: string
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return mobileWebBridgeRequestMessage({
    requestId,
    subscriptionId,
    capability: 'workspace',
    operation: 'hostSubscribe',
    payload: {
      workspaceId: `workspace_0_${'01'.repeat(16)}`,
      method: 'mobileWeb.session.subscribe',
      params: { workspaceId: `workspace_0_${'01'.repeat(16)}` }
    }
  }) as Extract<MobileWebBridgePageMessage, { type: 'request' }>
}

function lastCode(messages: MobileWebBridgeShellMessage[]): string | undefined {
  const last = messages.at(-1)
  return last?.type === 'response' && last.status === 'error' ? last.error.code : undefined
}

function bridgeId(index: number): string {
  return index.toString().padStart(22, 'Q')
}
