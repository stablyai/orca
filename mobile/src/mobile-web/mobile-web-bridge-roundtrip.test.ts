import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'
import {
  createMobileWebBridgeRoundtripFixture,
  MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT as CONTEXT
} from './mobile-web-bridge-roundtrip-fixture'
const OPAQUE_WORKSPACE_ID = `workspace_0_${'01'.repeat(16)}`

describe('mobile web bridge round trip', () => {
  it('serializes every production grant through the strict init contract', () => {
    expect(
      parseMobileWebBridgeShellMessage(
        JSON.stringify({
          version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
          type: 'init',
          shellSessionId: CONTEXT.shellSessionId,
          buildId: CONTEXT.buildId,
          connection: 'connected',
          grants: MOBILE_WEB_PRODUCTION_GRANTS
        }),
        CONTEXT
      )
    ).toMatchObject({ ok: true })
  })

  it('validates a page request, adapts worktree.ps, and validates the bounded response', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          worktrees: [
            {
              worktreeId: 'workspace-1',
              displayName: 'Primary workspace',
              repo: '/repo',
              branch: 'refs/heads/main',
              isActive: true,
              liveTerminalCount: 2,
              pairingCredential: 'must-not-cross-the-bridge'
            },
            {
              worktreeId: 'workspace-2',
              displayName: 'Second workspace',
              repo: '/repo',
              branch: 'feature',
              isActive: false,
              liveTerminalCount: 0
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          repoId: 'repo-1',
          worktreeId: 'workspace-1',
          activated: true,
          sleepingAgentWake: 'not-applicable'
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          worktree: 'workspace-1',
          publicationEpoch: 'epoch-1',
          snapshotVersion: 7,
          activeGroupId: 'group-1',
          activeTabId: 'terminal-1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'terminal-1',
              title: 'Codex',
              status: 'ready',
              terminal: 'secret-terminal-handle',
              isActive: true
            },
            {
              type: 'file',
              id: 'file-1',
              title: 'bridge.ts',
              filePath: '/private/repo/bridge.ts',
              relativePath: 'bridge.ts',
              language: 'typescript',
              isDirty: false,
              isActive: false
            },
            {
              type: 'browser',
              id: 'browser-1',
              browserPageId: 'browser-1',
              title: 'Review',
              url: 'https://example.invalid/?credential=secret',
              loading: false,
              canGoBack: true,
              canGoForward: false,
              isActive: false
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          worktree: 'workspace-1',
          publicationEpoch: 'epoch-1',
          snapshotVersion: 7,
          activeTabId: 'file-1',
          activeTabType: 'file',
          tabs: [
            {
              type: 'file',
              id: 'file-1',
              title: 'bridge.ts',
              filePath: '/private/repo/bridge.ts',
              isActive: true
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          tab: {
            type: 'terminal',
            id: 'terminal-2',
            title: 'Terminal',
            status: 'ready',
            terminal: 'secret-created-terminal-handle',
            isActive: true
          },
          publicationEpoch: 'epoch-1',
          snapshotVersion: 8
        }
      })
      .mockResolvedValueOnce({ ok: true, result: { browserPageId: 'browser-2' } })
      .mockResolvedValueOnce({ ok: true, result: { closed: true } })
      .mockResolvedValueOnce({ ok: true, result: { opened: true } })
    let hostSubscriptionListener: ((event: unknown) => void) | undefined
    const hostUnsubscribe = vi.fn()
    const subscribe = vi
      .fn<RpcClient['subscribe']>()
      .mockImplementation((_method, _params, listener) => {
        hostSubscriptionListener = listener
        return hostUnsubscribe
      })
    const requestIds = ['R', 'Q', 'T', 'U', 'V', 'W', 'X', 'Y', 'A', 'B']
    let requestIndex = 0
    const rpcClient = { sendRequest, subscribe } as unknown as RpcClient
    const { client } = createMobileWebBridgeRoundtripFixture({
      context: CONTEXT,
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
      rpcClient,
      createRequestId: () => (requestIds[requestIndex++] ?? 'Z').repeat(22),
      terminalClientId: 'device-token'
    })

    const firstWorkspacePage = await client.workspaceSnapshot({ limit: 1 })
    expect(firstWorkspacePage).toEqual({
      workspaces: [
        {
          id: `workspace_0_${'01'.repeat(16)}`,
          repoId: `repo_1_${'01'.repeat(16)}`,
          workspaceKind: 'git',
          name: 'Primary workspace',
          repo: 'repo',
          branch: 'main',
          folderName: '',
          workspaceStatus: '',
          sortOrder: 0,
          manualOrder: null,
          lastActivityAt: null,
          createdAt: null,
          isArchived: false,
          isMainWorktree: false,
          hasHostSidebarActivity: false,
          parentWorkspaceId: null,
          liveTerminalCount: 2,
          hasAttachedPty: false,
          unread: false,
          lastOutputAt: null,
          isPinned: false,
          isActive: true,
          linkedPR: null,
          linkedIssue: null,
          linkedLinearIssue: null,
          linkedGitLabMR: null,
          linkedGitLabIssue: null,
          comment: '',
          status: 'inactive',
          agents: []
        }
      ],
      truncated: true,
      nextCursor: `workspace_page_0_${'01'.repeat(16)}`
    })
    await expect(
      client.workspaceSnapshot({ limit: 1, cursor: firstWorkspacePage.nextCursor! })
    ).resolves.toMatchObject({
      workspaces: [{ name: 'Second workspace' }],
      truncated: false,
      nextCursor: null
    })
    expect(sendRequest).toHaveBeenCalledWith('worktree.ps', { limit: 10_001 })

    await expect(client.workspaceActivate({ workspaceId: OPAQUE_WORKSPACE_ID })).resolves.toEqual({
      workspaceId: OPAQUE_WORKSPACE_ID,
      activated: true,
      sleepingAgentWake: 'not-applicable'
    })
    expect(sendRequest).toHaveBeenCalledWith('worktree.activate', {
      worktree: 'id:workspace-1',
      notifyClients: false,
      navigation: 'caller'
    })

    await expect(client.sessionSnapshot({ workspaceId: OPAQUE_WORKSPACE_ID })).resolves.toEqual({
      workspaceId: OPAQUE_WORKSPACE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 7,
      workspaceTransportState: 'available',
      activeTabId: 'terminal-1',
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: 'terminal-1',
          title: 'Codex',
          status: 'ready',
          isActive: true
        },
        {
          type: 'file',
          id: 'file-1',
          title: 'bridge.ts',
          relativePath: 'bridge.ts',
          language: 'typescript',
          isActive: false
        },
        {
          type: 'browser',
          id: `browser_0_${'01'.repeat(16)}`,
          browserPageId: `browser_0_${'01'.repeat(16)}`,
          title: 'Review',
          url: 'https://example.invalid/',
          loading: false,
          canGoBack: true,
          canGoForward: false,
          isActive: false
        }
      ],
      truncated: false
    })
    expect(sendRequest).toHaveBeenCalledWith('session.tabs.list', {
      worktree: 'id:workspace-1'
    })

    await expect(
      client.sessionActivate({ workspaceId: OPAQUE_WORKSPACE_ID, tabId: 'file-1' })
    ).resolves.toMatchObject({
      workspaceId: OPAQUE_WORKSPACE_ID,
      activeTabId: 'file-1',
      tabs: [{ type: 'file', id: 'file-1', title: 'bridge.ts', isActive: true }]
    })
    expect(sendRequest).toHaveBeenCalledWith('session.tabs.activate', {
      worktree: 'id:workspace-1',
      tabId: 'file-1',
      notifyClients: false,
      navigation: 'caller'
    })

    await expect(client.sessionCreate({ workspaceId: OPAQUE_WORKSPACE_ID })).resolves.toEqual({
      workspaceId: OPAQUE_WORKSPACE_ID,
      tabId: 'terminal-2',
      created: true
    })
    expect(sendRequest).toHaveBeenCalledWith('session.tabs.createTerminal', {
      worktree: 'id:workspace-1',
      activate: true,
      select: true,
      navigation: 'caller',
      clientMutationId: 'W'.repeat(22)
    })

    await expect(
      client.sessionCreateBrowser({
        workspaceId: OPAQUE_WORKSPACE_ID,
        url: 'https://example.com'
      })
    ).resolves.toEqual({
      workspaceId: OPAQUE_WORKSPACE_ID,
      browserPageId: `browser_1_${'01'.repeat(16)}`
    })
    expect(sendRequest).toHaveBeenCalledWith('browser.tabCreate', {
      worktree: 'id:workspace-1',
      url: 'https://example.com',
      activate: true
    })

    await expect(
      client.sessionClose({ workspaceId: OPAQUE_WORKSPACE_ID, tabId: 'terminal-2' })
    ).resolves.toEqual({
      workspaceId: OPAQUE_WORKSPACE_ID,
      tabId: 'terminal-2',
      outcome: 'closed',
      refusalReason: null
    })
    expect(sendRequest).toHaveBeenCalledWith('session.tabs.close', {
      worktree: 'id:workspace-1',
      tabId: 'terminal-2',
      reason: 'user'
    })

    await expect(
      client.fileOpen({
        workspaceId: OPAQUE_WORKSPACE_ID,
        relativePath: 'README.md'
      })
    ).resolves.toBeNull()
    expect(sendRequest).toHaveBeenCalledWith('files.open', {
      worktree: 'id:workspace-1',
      relativePath: 'README.md'
    })

    const liveSnapshots: unknown[] = []
    const liveErrors: unknown[] = []
    const subscription = client.sessionSubscribe(
      { workspaceId: OPAQUE_WORKSPACE_ID },
      (snapshot) => liveSnapshots.push(snapshot),
      (error) => liveErrors.push(error)
    )
    await expect(subscription.ready).resolves.toBeUndefined()
    expect(subscribe).toHaveBeenCalledWith(
      'session.tabs.subscribe',
      { worktree: 'id:workspace-1' },
      expect.any(Function)
    )
    hostSubscriptionListener?.({
      type: 'updated',
      worktree: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 8,
      activeTabId: 'file-1',
      activeTabType: 'file',
      tabs: [
        {
          type: 'file',
          id: 'file-1',
          title: 'live.ts',
          filePath: '/private/repo/live.ts',
          relativePath: 'src/live.ts',
          language: 'typescript',
          mode: 'edit',
          isDirty: false,
          isActive: true
        }
      ]
    })
    await vi.waitFor(() => expect(liveSnapshots).toHaveLength(1))
    expect(liveSnapshots[0]).toEqual({
      workspaceId: OPAQUE_WORKSPACE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 8,
      workspaceTransportState: 'available',
      activeTabId: 'file-1',
      activeTabType: 'file',
      tabs: [
        {
          type: 'file',
          id: 'file-1',
          title: 'live.ts',
          relativePath: 'src/live.ts',
          language: 'typescript',
          mode: 'edit',
          isActive: true
        }
      ],
      truncated: false
    })
    expect(liveErrors).toEqual([])
    subscription.unsubscribe()
    expect(hostUnsubscribe).toHaveBeenCalledOnce()
  })
})
