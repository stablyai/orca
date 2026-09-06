import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

describe('mobile web native chat pending delivery round trip', () => {
  it('resolves page handles before shell persistence and returns only bounded records', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({ worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] })
      )
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(success(sessionSnapshot()))
    const sessionChatPendingRead = vi
      .fn()
      .mockResolvedValue([{ text: 'restored pending', expectedOccurrence: 1 }])
    const sessionChatPendingWrite = vi.fn().mockResolvedValue(undefined)
    const rpcClient = { sendRequest } as unknown as RpcClient
    let requestIndex = 0
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
      rpcClient,
      createRequestId: () => `${String.fromCharCode(65 + requestIndex++)}`.repeat(22),
      nativeAuthority: {
        sessionChatPendingRead,
        sessionChatPendingWrite
      },
      terminalClientId: 'device'
    })

    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const session = await client.sessionSnapshot({ workspaceId: workspace.id })
    const tab = session.tabs[0]!
    expect(tab.type).toBe('terminal')
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Expected native chat authority')
    }

    await expect(
      client.nativeChat.pendingRead({
        workspaceId: workspace.id,
        sessionId: tab.nativeChatSessionId
      })
    ).resolves.toEqual({
      deliveries: [{ text: 'restored pending', expectedOccurrence: 1 }]
    })
    await client.nativeChat.pendingWrite({
      workspaceId: workspace.id,
      sessionId: tab.nativeChatSessionId,
      deliveries: [{ text: 'next pending', expectedOccurrence: 2 }]
    })

    expect(sessionChatPendingRead).toHaveBeenCalledWith(
      'host-workspace',
      'host-tab',
      'provider-session'
    )
    expect(sessionChatPendingWrite).toHaveBeenCalledWith(
      'host-workspace',
      'host-tab',
      'provider-session',
      [{ text: 'next pending', expectedOccurrence: 2 }]
    )
    expect(
      JSON.stringify([...sessionChatPendingRead.mock.calls, ...sessionChatPendingWrite.mock.calls])
    ).not.toContain(tab.nativeChatSessionId)
  })
})

function sessionSnapshot() {
  return {
    worktree: 'host-workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeTabId: 'host-tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab',
        title: 'Codex',
        status: 'ready',
        terminal: 'host-terminal',
        launchAgent: 'codex',
        isActive: true,
        agentStatus: {
          state: 'waiting',
          agentType: 'codex',
          providerSession: { id: 'provider-session' }
        }
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
