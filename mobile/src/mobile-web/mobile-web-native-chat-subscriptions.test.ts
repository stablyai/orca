import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebNativeChatSubscriptions } from './mobile-web-native-chat-subscriptions'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web native chat subscriptions', () => {
  it('sanitizes transcript frames and stops delivery after authority revocation', async () => {
    const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
    workspaceAuthority.synchronize([{ workspaceId: 'workspace-1', repoId: 'repo-1' }])
    const nativeChatAuthority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const sessionId = nativeChatAuthority.register({
      hostWorkspaceId: 'workspace-1',
      hostTabId: 'tab-1',
      hostTerminalId: 'terminal-1',
      agent: 'claude',
      providerSessionId: 'provider-session-1'
    })
    const postEvent = vi.fn().mockResolvedValue(undefined)
    const postClosed = vi.fn()
    const subscriptions = new MobileWebNativeChatSubscriptions({
      isActive: () => true,
      postEvent,
      postClosed,
      nativeChatAuthority,
      workspaceAuthority
    })
    let emit: (value: unknown) => void = () => {}
    const unsubscribe = vi.fn()
    const client = {
      sendRequest: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1',
              terminal: 'terminal-1',
              launchAgent: 'claude',
              agentStatus: {
                agentType: 'claude',
                providerSession: { id: 'provider-session-1' }
              }
            }
          ]
        }
      }),
      subscribe: vi.fn((_method, _params, onEvent) => {
        emit = onEvent
        return unsubscribe
      })
    } as unknown as RpcClient

    await subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      payload: {
        workspaceId: workspaceAuthority.pageWorkspaceId('workspace-1'),
        sessionId,
        limit: 40
      },
      client,
      isRequestActive: () => true
    })
    emit({
      type: 'snapshot',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Ready' }],
          timestamp: 1,
          source: 'transcript'
        }
      ],
      hasMore: false,
      lifecycle: { state: 'interrupted', turnId: 'private-provider-turn', timestamp: 2 }
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(postEvent).toHaveBeenCalledWith('subscription-1', 0, {
      type: 'snapshot',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Ready' }],
          timestamp: 1,
          source: 'transcript'
        }
      ],
      hasMore: false,
      lifecycle: { state: 'interrupted', turnId: 'private-provider-turn', timestamp: 2 }
    })

    nativeChatAuthority.revoke(sessionId)
    emit({ type: 'appended', messages: [] })
    await Promise.resolve()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(postEvent).toHaveBeenCalledOnce()
    // The page must learn the transcript stream is over; silence leaves it on its last messages.
    expect(postClosed).toHaveBeenCalledWith('subscription-1', {
      code: 'not_found',
      retryable: false
    })
  })

  it('does not register after the owning bridge request is cancelled', async () => {
    const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
    workspaceAuthority.synchronize([{ workspaceId: 'workspace-1', repoId: 'repo-1' }])
    const nativeChatAuthority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const sessionId = nativeChatAuthority.register({
      hostWorkspaceId: 'workspace-1',
      hostTabId: 'tab-1',
      hostTerminalId: 'terminal-1',
      agent: 'claude',
      providerSessionId: 'provider-session-1'
    })
    let resolveTabs: (value: { ok: true; result: unknown }) => void = () => {}
    const sendRequest = vi.fn(
      () =>
        new Promise<{ ok: true; result: unknown }>((resolve) => {
          resolveTabs = resolve
        })
    )
    const subscribe = vi.fn()
    const subscriptions = new MobileWebNativeChatSubscriptions({
      isActive: () => true,
      postEvent: vi.fn(),
      postClosed: vi.fn(),
      nativeChatAuthority,
      workspaceAuthority
    })
    let active = true
    const pending = subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      payload: {
        workspaceId: workspaceAuthority.pageWorkspaceId('workspace-1'),
        sessionId,
        limit: 40
      },
      client: { sendRequest, subscribe } as unknown as RpcClient,
      isRequestActive: () => active
    })

    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledOnce())
    active = false
    resolveTabs({
      ok: true,
      result: {
        tabs: [
          {
            type: 'terminal',
            id: 'tab-1',
            terminal: 'terminal-1',
            agentStatus: {
              agentType: 'claude',
              providerSession: { id: 'provider-session-1' }
            }
          }
        ]
      }
    })

    await expect(pending).rejects.toThrow('cancelled')
    expect(subscribe).not.toHaveBeenCalled()
  })
})
