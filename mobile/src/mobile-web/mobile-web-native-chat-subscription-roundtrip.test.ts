import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

describe('mobile web native chat subscription round trip', () => {
  it('tails a restored session through opaque page authority', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({ worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] })
      )
      .mockResolvedValueOnce(success(restoredSessionSnapshot()))
      .mockResolvedValueOnce(success(restoredSessionSnapshot()))
    let emitHostEvent: (event: unknown) => void = () => {}
    const unsubscribeHost = vi.fn()
    const subscribe = vi
      .fn<RpcClient['subscribe']>()
      .mockImplementation((_method, _params, onEvent) => {
        emitHostEvent = onEvent
        return unsubscribeHost
      })
    const rpcClient = { sendRequest, subscribe } as unknown as RpcClient
    let requestIndex = 0
    const { client, dispose } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
      rpcClient,
      createRequestId: () => `${String.fromCharCode(65 + requestIndex++)}`.repeat(22),
      terminalClientId: 'device'
    })

    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const session = await client.sessionSnapshot({ workspaceId: workspace.id })
    const tab = session.tabs[0]!
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Expected native chat authority')
    }
    const events: unknown[] = []
    const errors: unknown[] = []
    const subscription = client.nativeChatSubscribe(
      {
        workspaceId: workspace.id,
        sessionId: tab.nativeChatSessionId,
        limit: 40
      },
      (event) => events.push(event),
      (error) => errors.push(error)
    )

    await expect(subscription.ready).resolves.toBeUndefined()
    expect(subscribe).toHaveBeenCalledWith(
      'nativeChat.subscribe',
      {
        agent: 'codex',
        sessionId: 'provider-session',
        limit: 40,
        subscriptionId: subscription.subscriptionId,
        transcriptPath: '/private/restored-session.jsonl',
        worktreeId: 'host-workspace',
        terminal: 'current-host-terminal'
      },
      expect.any(Function)
    )

    emitHostEvent({
      type: 'snapshot',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Restored' }],
          timestamp: 1,
          source: 'transcript'
        }
      ],
      hasMore: false
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(errors).toEqual([])
    expect(JSON.stringify(events)).not.toContain('provider-session')
    expect(JSON.stringify(events)).not.toContain('/private/restored-session')

    subscription.unsubscribe()
    expect(unsubscribeHost).toHaveBeenCalledOnce()
    dispose()
  })

  it('keeps streaming a Claude edit turn the host enriched past this wire', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({ worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] })
      )
      .mockResolvedValueOnce(success(restoredSessionSnapshot()))
      .mockResolvedValueOnce(success(restoredSessionSnapshot()))
    let emitHostEvent: (event: unknown) => void = () => {}
    const subscribe = vi
      .fn<RpcClient['subscribe']>()
      .mockImplementation((_method, _params, onEvent) => {
        emitHostEvent = onEvent
        return vi.fn()
      })
    let requestIndex = 0
    const { client, dispose } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
      rpcClient: { sendRequest, subscribe } as unknown as RpcClient,
      createRequestId: () => `${String.fromCharCode(65 + requestIndex++)}`.repeat(22),
      terminalClientId: 'device'
    })

    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const session = await client.sessionSnapshot({ workspaceId: workspace.id })
    const tab = session.tabs[0]!
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Expected native chat authority')
    }
    const events: unknown[] = []
    const errors: unknown[] = []
    const subscription = client.nativeChatSubscribe(
      { workspaceId: workspace.id, sessionId: tab.nativeChatSessionId, limit: 40 },
      (event) => events.push(event),
      (error) => errors.push(error)
    )
    await expect(subscription.ready).resolves.toBeUndefined()

    emitHostEvent({
      type: 'appended',
      messages: [
        {
          id: 'message-2',
          role: 'assistant',
          blocks: [
            { type: 'text', text: 'x'.repeat(64_000) },
            { type: 'tool-call', name: 'Edit', input: { file_path: 'a.ts' }, state: 'running' }
          ],
          timestamp: 2,
          source: 'transcript'
        },
        {
          id: 'message-3',
          role: 'tool',
          blocks: [
            {
              type: 'tool-result',
              output: 'Edited a.ts',
              editPatch: {
                filePath: 'a.ts',
                hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
              }
            }
          ],
          timestamp: 3,
          source: 'transcript'
        }
      ]
    })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(errors).toEqual([])
    const appended = events[0] as {
      messages: { blocks: ({ text?: string } & Record<string, unknown>)[] }[]
    }
    expect(appended.messages[0]?.blocks[0]?.text).toHaveLength(4200)
    expect(appended.messages[0]?.blocks[1]).toMatchObject({ state: 'running' })
    expect(appended.messages[1]?.blocks[0]).toEqual({
      type: 'tool-result',
      output: 'Edited a.ts'
    })

    subscription.unsubscribe()
    dispose()
  })
})

function restoredSessionSnapshot() {
  return {
    worktree: 'host-workspace',
    publicationEpoch: 'restored-epoch',
    snapshotVersion: 1,
    activeTabId: 'host-tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab',
        title: 'Codex',
        status: 'ready',
        terminal: 'current-host-terminal',
        launchAgent: 'codex',
        isActive: true,
        agentStatus: {
          state: 'done',
          agentType: 'codex',
          terminalHandle: 'pre-restart-terminal',
          providerSession: {
            id: 'provider-session',
            transcriptPath: '/private/restored-session.jsonl'
          }
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
