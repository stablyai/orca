import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const SESSION_ID = 'provider-session'
const TABS = {
  worktree: 'workspace-1',
  tabs: [
    {
      id: 'tab-1',
      type: 'terminal',
      terminal: 'terminal-secret',
      agentStatus: {
        agentType: 'claude',
        providerSession: { id: SESSION_ID, transcriptPath: '/private/transcript.jsonl' }
      }
    }
  ]
}
const OPERATION_RUNTIME = { terminalClientId: 'mobile-device' }

describe('mobile web native chat operations', () => {
  it('persists pending delivery through stable hidden chat authority', async () => {
    const context = operationContext()
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(success(TABS))
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
          sessionId: context.sessionId
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
    expect(sessionChatPendingRead).toHaveBeenCalledWith('workspace-1', 'tab-1', SESSION_ID)

    await expect(
      executeMobileWebNativeChatOperation({
        operation: 'pendingWrite',
        payload: {
          workspaceId: context.pageWorkspaceId,
          sessionId: context.sessionId,
          deliveries: [{ text: 'next', expectedOccurrence: 3 }]
        },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: context.workspaceAuthority,
        nativeChatAuthority: context.nativeChatAuthority,
        nativeAuthority,
        ...OPERATION_RUNTIME
      })
    ).resolves.toBeNull()
    expect(sessionChatPendingWrite).toHaveBeenCalledWith('workspace-1', 'tab-1', SESSION_ID, [
      { text: 'next', expectedOccurrence: 3 }
    ])
  })
})

function operationContext() {
  const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  workspaceAuthority.synchronize(['workspace-1'])
  const nativeChatAuthority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
  return {
    workspaceAuthority,
    nativeChatAuthority,
    pageWorkspaceId: workspaceAuthority.pageWorkspaceId('workspace-1'),
    sessionId: SESSION_ID
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
