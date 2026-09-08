import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web mutation authorization races', () => {
  it('rejects native-chat persistence when the tab lookup loses its workspace authority', async () => {
    const workspace = workspaceAuthority()
    const chat = new MobileWebNativeChatAuthority((length) => new Uint8Array(length).fill(5))
    const tabs = deferredResult()
    const sendRequest = vi.fn(() => tabs.promise)
    const sessionChatPendingWrite = vi.fn().mockResolvedValue(undefined)
    const pending = executeMobileWebNativeChatOperation({
      operation: 'pendingWrite',
      payload: {
        workspaceId: workspace.pageId,
        sessionId: 'provider-session-a',
        deliveries: [{ text: 'pending', expectedOccurrence: 1 }]
      },
      client: client(sendRequest),
      workspaceAuthority: workspace.authority,
      nativeChatAuthority: chat,
      nativeAuthority: { sessionChatPendingWrite },
      terminalClientId: 'mobile-client'
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1))
    workspace.remove()
    tabs.resolve(success(chatTabs))

    await rejection
    expect(sessionChatPendingWrite).not.toHaveBeenCalled()
  })
})

const chatTabs = {
  worktree: 'workspace-a',
  tabs: [
    {
      id: 'tab-a',
      type: 'terminal',
      terminal: 'terminal-a',
      agentStatus: {
        agentType: 'claude',
        providerSession: { id: 'provider-session-a', transcriptPath: '/private/transcript.jsonl' }
      }
    }
  ]
}

function workspaceAuthority() {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(7))
  authority.synchronize(['workspace-a'])
  return {
    authority,
    pageId: authority.pageWorkspaceId('workspace-a'),
    remove: () => authority.synchronize([])
  }
}

function deferredResult() {
  let resolve = (_value: ReturnType<typeof success>): void => {}
  const promise = new Promise<ReturnType<typeof success>>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function client(sendRequest: ReturnType<typeof vi.fn>): RpcClient {
  return { sendRequest } as unknown as RpcClient
}

function success(result: unknown) {
  return { ok: true as const, result }
}
