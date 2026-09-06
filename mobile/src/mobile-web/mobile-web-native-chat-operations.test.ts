import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const binding = {
  hostWorkspaceId: 'workspace-1',
  hostTabId: 'tab-1',
  hostTerminalId: 'terminal-secret',
  agent: 'claude',
  providerSessionId: 'provider-session-secret',
  transcriptPath: '/private/transcript.jsonl'
}
const OPERATION_RUNTIME = {
  terminalClientId: 'mobile-device'
}

describe('mobile web native chat operations', () => {
  it('resolves an opaque session against a fresh tab before sending', async () => {
    const context = operationContext()
    const deadline = Date.now() + 15_000
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(
        success({ send: { handle: 'terminal-secret', accepted: true, bytesWritten: 5 } })
      )

    await expect(
      executeMobileWebNativeChatOperation({
        operation: 'sendMessage',
        payload: {
          workspaceId: context.pageWorkspaceId,
          sessionId: context.pageSessionId,
          text: 'hello',
          deadline,
          clearInputFirst: true
        },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: context.workspaceAuthority,
        nativeChatAuthority: context.nativeChatAuthority,
        nativeAuthority: {},
        ...OPERATION_RUNTIME
      })
    ).resolves.toEqual({ outcome: 'accepted' })
    expect(sendRequest).toHaveBeenNthCalledWith(1, 'session.tabs.list', {
      worktree: 'id:workspace-1'
    })
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      'terminal.send',
      {
        terminal: 'terminal-secret',
        text: '\x15hello',
        enter: true,
        client: { id: 'mobile-device', type: 'mobile' }
      },
      { timeoutMs: expect.any(Number), budgetSpansConnect: true }
    )
  })

  it('revokes stale authority before any terminal mutation', async () => {
    const context = operationContext()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue(success(sessionSnapshot({ providerSessionId: 'different-session' })))

    await expect(
      executeMobileWebNativeChatOperation({
        operation: 'respond',
        payload: {
          workspaceId: context.pageWorkspaceId,
          sessionId: context.pageSessionId,
          text: '1',
          enter: false,
          deadline: Date.now() + 15_000
        },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: context.workspaceAuthority,
        nativeChatAuthority: context.nativeChatAuthority,
        nativeAuthority: {},
        ...OPERATION_RUNTIME
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(() => context.nativeChatAuthority.resolve('workspace-1', context.pageSessionId)).toThrow(
      'not_found'
    )
  })

  it('uses hidden provider authority for transcript reads without returning it', async () => {
    const context = operationContext()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(
        success({
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
          beforeOffset: 0,
          lifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 2 }
        })
      )

    const result = await executeMobileWebNativeChatOperation({
      operation: 'read',
      payload: {
        workspaceId: context.pageWorkspaceId,
        sessionId: context.pageSessionId,
        limit: 40
      },
      client: { sendRequest } as unknown as RpcClient,
      workspaceAuthority: context.workspaceAuthority,
      nativeChatAuthority: context.nativeChatAuthority,
      nativeAuthority: {},
      ...OPERATION_RUNTIME
    })

    expect(sendRequest).toHaveBeenNthCalledWith(2, 'nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'provider-session-secret',
      limit: 40,
      transcriptPath: '/private/transcript.jsonl',
      worktreeId: 'workspace-1',
      terminal: 'terminal-secret'
    })
    const serialized = JSON.stringify(result)
    expect(serialized).toContain('Ready')
    expect(serialized).not.toContain('provider-session-secret')
    expect(serialized).not.toContain('/private/transcript')
    expect(serialized).not.toContain('terminal-secret')
    expect(result).toMatchObject({
      lifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 2 }
    })
  })

  // An unreachable SSH host strips agentStatus from a terminal that still exists. Revoking the
  // grant there reported the session as gone; the read must surface the host failure instead.
  it('keeps the grant when the host stops reporting agent status', async () => {
    const context = operationContext()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(sessionSnapshot({ unreachable: true })))
      .mockResolvedValueOnce(success({ error: 'Transcript unavailable' }))

    await expect(
      executeMobileWebNativeChatOperation({
        operation: 'read',
        payload: {
          workspaceId: context.pageWorkspaceId,
          sessionId: context.pageSessionId,
          limit: 40
        },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: context.workspaceAuthority,
        nativeChatAuthority: context.nativeChatAuthority,
        nativeAuthority: {},
        ...OPERATION_RUNTIME
      })
    ).rejects.toMatchObject({ code: 'host_error' })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(context.nativeChatAuthority.resolve('workspace-1', context.pageSessionId)).toMatchObject(
      { providerSessionId: 'provider-session-secret' }
    )
  })

  it('persists pending delivery through stable hidden chat authority', async () => {
    const context = operationContext()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue(success(sessionSnapshot()))
    const sessionChatPendingRead = vi
      .fn<NonNullable<MobileWebNativeCapabilityAuthority['sessionChatPendingRead']>>()
      .mockResolvedValue([{ text: 'pending', expectedOccurrence: 2 }])
    const sessionChatPendingWrite = vi
      .fn<NonNullable<MobileWebNativeCapabilityAuthority['sessionChatPendingWrite']>>()
      .mockResolvedValue(undefined)
    const nativeAuthority = { sessionChatPendingRead, sessionChatPendingWrite }

    await expect(
      executeMobileWebNativeChatOperation({
        operation: 'pendingRead',
        payload: {
          workspaceId: context.pageWorkspaceId,
          sessionId: context.pageSessionId
        },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: context.workspaceAuthority,
        nativeChatAuthority: context.nativeChatAuthority,
        nativeAuthority,
        ...OPERATION_RUNTIME
      })
    ).resolves.toEqual({
      deliveries: [{ text: 'pending', expectedOccurrence: 2 }]
    })
    expect(sessionChatPendingRead).toHaveBeenCalledWith(
      'workspace-1',
      'tab-1',
      'provider-session-secret'
    )

    await expect(
      executeMobileWebNativeChatOperation({
        operation: 'pendingWrite',
        payload: {
          workspaceId: context.pageWorkspaceId,
          sessionId: context.pageSessionId,
          deliveries: [{ text: 'next', expectedOccurrence: 3 }]
        },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: context.workspaceAuthority,
        nativeChatAuthority: context.nativeChatAuthority,
        nativeAuthority,
        ...OPERATION_RUNTIME
      })
    ).resolves.toBeNull()
    expect(sessionChatPendingWrite).toHaveBeenCalledWith(
      'workspace-1',
      'tab-1',
      'provider-session-secret',
      [{ text: 'next', expectedOccurrence: 3 }]
    )
    expect(JSON.stringify(sessionChatPendingWrite.mock.calls)).not.toContain(context.pageSessionId)
  })
})

function operationContext() {
  const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  workspaceAuthority.synchronize([{ workspaceId: 'workspace-1', repoId: 'repo-1' }])
  const nativeChatAuthority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
  return {
    workspaceAuthority,
    nativeChatAuthority,
    pageWorkspaceId: workspaceAuthority.pageWorkspaceId('workspace-1'),
    pageSessionId: nativeChatAuthority.register(binding)
  }
}

function sessionSnapshot(overrides: { providerSessionId?: string; unreachable?: boolean } = {}) {
  return {
    worktree: 'workspace-1',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1',
        terminal: 'terminal-secret',
        launchAgent: 'claude',
        ...(overrides.unreachable
          ? {}
          : {
              agentStatus: {
                state: 'waiting',
                agentType: 'claude',
                providerSession: {
                  id: overrides.providerSessionId ?? 'provider-session-secret',
                  transcriptPath: '/private/transcript.jsonl'
                }
              }
            })
      }
    ]
  }
}

function success(result: unknown) {
  return {
    id: 'response',
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime' }
  }
}
