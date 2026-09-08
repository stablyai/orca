import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionTabOperations } from './web-host-session-tab-operations'

describe('web host session tab operations', () => {
  it('reads the reviewed runtime gates through the named bridge operation', async () => {
    const client = bridgeClient()
    const operations = webHostSessionTabOperations(client as unknown as MobileWebBridgeClient)

    await expect(operations.runtimeCapabilities()).resolves.toEqual({
      browserScreencastSupported: true,
      agentHistorySupported: true,
      quickCommandsSupported: true,
      terminalQueryReplyInputSupported: true
    })
    expect(client.sessionCapabilities).toHaveBeenCalledWith({})
  })

  it('adapts bridge snapshots into the existing mobile session view model', async () => {
    const client = bridgeClient()
    const operations = webHostSessionTabOperations(client as unknown as MobileWebBridgeClient)

    await expect(operations.snapshot('workspace-page-1')).resolves.toEqual({
      worktree: 'workspace-page-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 4,
      activeTabId: 'terminal-1',
      activeTabType: 'terminal',
      tabs: [
        {
          id: 'terminal-1',
          title: 'Terminal',
          type: 'terminal',
          status: 'ready',
          terminal: 'terminal-1',
          isActive: true
        },
        {
          id: 'file-1',
          title: 'secret.ts',
          type: 'file',
          filePath: 'mobile-web-tab:file-1',
          relativePath: '',
          language: 'plaintext',
          isDirty: false,
          isActive: false
        }
      ]
    })
    expect(client.sessionSnapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1'
    })
  })

  it('routes activate, close, and subscription cleanup through named bridge methods', async () => {
    const client = bridgeClient()
    const operations = webHostSessionTabOperations(client as unknown as MobileWebBridgeClient)
    const onSnapshot = vi.fn()
    const cleanup = operations.subscribe('workspace-page-1', onSnapshot, vi.fn())

    client.onSnapshot?.(snapshot())
    await operations.activate('workspace-page-1', 'terminal-1')
    await expect(operations.close('workspace-page-1', 'terminal-1')).resolves.toEqual({
      outcome: 'closed'
    })
    cleanup()

    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: 'workspace-page-1', snapshotVersion: 4 })
    )
    expect(client.sessionActivate).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1',
      tabId: 'terminal-1'
    })
    expect(client.sessionClose).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1',
      tabId: 'terminal-1'
    })
    expect(client.unsubscribe).toHaveBeenCalledOnce()
  })

  it('creates a blank terminal through the named bridge operation and refreshes the snapshot', async () => {
    const client = bridgeClient()
    const operations = webHostSessionTabOperations(client as unknown as MobileWebBridgeClient)

    await expect(operations.createBlank('workspace-page-1')).resolves.toEqual(
      expect.objectContaining({
        worktree: 'workspace-page-1',
        snapshotVersion: 4,
        activeTabId: 'terminal-1'
      })
    )

    expect(client.sessionCreate).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1'
    })
    expect(client.sessionSnapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1'
    })
  })

  it('loads agent choices and creates an agent through named bridge operations', async () => {
    const client = bridgeClient()
    const operations = webHostSessionTabOperations(client as unknown as MobileWebBridgeClient)

    await expect(operations.agentOptions('workspace-page-1')).resolves.toEqual([
      { agent: 'codex', label: 'Codex' },
      { agent: 'claude', label: 'Claude' }
    ])
    await expect(operations.createAgent('workspace-page-1', 'codex')).resolves.toEqual(
      expect.objectContaining({
        worktree: 'workspace-page-1',
        activeTabId: 'terminal-1'
      })
    )
    expect(client.sessionAgentOptions).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1'
    })
    expect(client.sessionCreateAgent).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1',
      agent: 'codex'
    })
  })

  it('creates a saved quick command and returns its initial-input projection', async () => {
    const client = bridgeClient()
    const operations = webHostSessionTabOperations(client as unknown as MobileWebBridgeClient)

    await expect(operations.createQuickCommand?.('workspace-page-1', 'command-1')).resolves.toEqual(
      {
        snapshot: expect.objectContaining({
          worktree: 'workspace-page-1',
          activeTabId: 'terminal-1'
        }),
        tabId: 'terminal-1',
        initialInput: {
          text: 'git status',
          enter: false,
          successToast: 'Status inserted'
        }
      }
    )
    expect(client.sessionCreateQuickCommand).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1',
      commandId: 'command-1'
    })
    expect(client.sessionSnapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1'
    })
  })

  it('creates a browser through the named bridge operation', async () => {
    const client = bridgeClient()
    const operations = webHostSessionTabOperations(client as unknown as MobileWebBridgeClient)

    await expect(
      operations.createBrowser('workspace-page-1', 'https://example.com')
    ).resolves.toEqual({ browserPageId: 'browser-1' })
    expect(client.sessionCreateBrowser).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1',
      url: 'https://example.com'
    })
  })
})

function bridgeClient() {
  const client = {
    onSnapshot: null as ((value: ReturnType<typeof snapshot>) => void) | null,
    unsubscribe: vi.fn(),
    sessionCapabilities: vi.fn().mockResolvedValue({
      browserScreencastSupported: true,
      agentHistorySupported: true,
      quickCommandsSupported: true,
      terminalQueryReplyInputSupported: true
    }),
    sessionSnapshot: vi.fn().mockResolvedValue(snapshot()),
    sessionAgentOptions: vi.fn().mockResolvedValue({ agents: ['codex', 'claude'] }),
    sessionCreate: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-page-1',
      tabId: 'terminal-1',
      outcome: 'created'
    }),
    sessionCreateAgent: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-page-1',
      tabId: 'terminal-1',
      created: true
    }),
    sessionCreateQuickCommand: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-page-1',
      tabId: 'terminal-1',
      created: true,
      initialInput: {
        text: 'git status',
        enter: false,
        successToast: 'Status inserted'
      }
    }),
    sessionCreateBrowser: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-page-1',
      browserPageId: 'browser-1'
    }),
    sessionActivate: vi.fn().mockResolvedValue(snapshot()),
    sessionClose: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-page-1',
      tabId: 'terminal-1',
      outcome: 'closed',
      refusalReason: null
    }),
    sessionSubscribe: vi.fn((_payload, onSnapshot) => {
      client.onSnapshot = onSnapshot
      return { ready: Promise.resolve(), unsubscribe: client.unsubscribe }
    })
  }
  return client
}

function snapshot() {
  return {
    workspaceId: 'workspace-page-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 4,
    activeTabId: 'terminal-1',
    activeTabType: 'terminal' as const,
    tabs: [
      {
        id: 'terminal-1',
        title: 'Terminal',
        type: 'terminal' as const,
        status: 'ready' as const,
        isActive: true
      },
      {
        id: 'file-1',
        title: 'secret.ts',
        type: 'file' as const,
        isActive: false
      }
    ],
    truncated: false
  }
}
