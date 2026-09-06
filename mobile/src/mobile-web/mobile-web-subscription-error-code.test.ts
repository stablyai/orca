import { describe, expect, it, vi } from 'vitest'
import type {
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebAccountSubscriptions } from './mobile-web-account-subscriptions'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebBrowserStreams } from './mobile-web-browser-streams'
import {
  isRetryableMobileWebBridgeError,
  mobileWebBridgeErrorCode
} from './mobile-web-broker-error'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebSessionSubscriptions } from './mobile-web-session-subscriptions'
import { MobileWebSourceControlSubscriptions } from './mobile-web-source-control-subscriptions'
import { MobileWebWorkspaceSubscriptions } from './mobile-web-workspace-subscriptions'
import {
  mobileWebHostWorkspaceIdFromHost,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

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
  workspaceAuthority.synchronize([{ workspaceId: 'host-workspace', repoId: 'repo-1' }])
  const pageWorkspaceId = workspaceAuthority.pageWorkspaceId('host-workspace')
  const browserAuthority = new MobileWebBrowserAuthority(randomBytes)
  const pageId = browserAuthority.register('host-workspace', 'raw-page')
  const nativeChatAuthority = new MobileWebNativeChatAuthority(randomBytes)

  const postClosed = (): void => {}
  const account = new MobileWebAccountSubscriptions({ isActive, postEvent, postClosed })
  const workspace = new MobileWebWorkspaceSubscriptions({ isActive, postEvent, postClosed })
  const session = new MobileWebSessionSubscriptions({
    isActive,
    postEvent,
    postClosed,
    browserAuthority,
    nativeChatAuthority
  })
  const sourceControl = new MobileWebSourceControlSubscriptions({
    isActive,
    workspaceAuthority,
    postEvent,
    postClosed
  })
  const browser = new MobileWebBrowserStreams({
    isActive,
    workspaceAuthority,
    browserAuthority,
    postEvent,
    postClosed
  })
  return [
    {
      name: 'account',
      start: (subscriptionId) => account.start({ requestId: 'r', subscriptionId, client })
    },
    {
      name: 'workspace',
      start: (subscriptionId) => workspace.start({ requestId: 'r', subscriptionId, client })
    },
    {
      name: 'session',
      start: (subscriptionId) =>
        session.start({
          requestId: 'r',
          subscriptionId,
          pageWorkspaceId,
          hostWorkspaceId: mobileWebHostWorkspaceIdFromHost('host-workspace'),
          client
        })
    },
    {
      name: 'sourceControl',
      start: (subscriptionId) =>
        sourceControl.start({
          requestId: 'r',
          subscriptionId,
          pageWorkspaceId,
          hostWorkspaceId: 'host-workspace',
          client
        })
    },
    {
      name: 'browser',
      start: (subscriptionId) =>
        browser.start({
          requestId: 'r',
          subscriptionId,
          payload: {
            workspaceId: pageWorkspaceId,
            pageId,
            format: 'jpeg',
            quality: 72,
            maxWidth: 800,
            maxHeight: 600,
            everyNthFrame: 1,
            minFrameIntervalMs: 100
          },
          client
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
    const client = { subscribe: vi.fn(() => () => {}), sendRequest } as unknown as RpcClient
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
    capability: 'session',
    operation: 'subscribe',
    payload: { workspaceId: `workspace_0_${'01'.repeat(16)}` }
  }) as Extract<MobileWebBridgePageMessage, { type: 'request' }>
}

function lastCode(messages: MobileWebBridgeShellMessage[]): string | undefined {
  const last = messages.at(-1)
  return last?.type === 'response' && last.status === 'error' ? last.error.code : undefined
}

function bridgeId(index: number): string {
  return index.toString().padStart(22, 'Q')
}
