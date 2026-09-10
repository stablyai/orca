import { describe, expect, it } from 'vitest'
import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalListResult
} from '../../../../shared/runtime-types'
import { mergeMaestroWorkspaceTerminalInventory } from './maestro-workspace-leased-terminal-projection'

const scope = { execution_host_id: 'local', workspace_key: 'folder:orchestration' }

function emptySession(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'folder:orchestration',
    publicationEpoch: 'renderer-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function terminalList(): RuntimeTerminalListResult {
  return {
    terminals: [
      {
        handle: 'term-coordinator',
        ptyId: 'pty-coordinator',
        incarnationId: 'incarnation-1',
        worktreeId: 'folder:orchestration',
        worktreePath: '',
        branch: '',
        tabId: 'tab-coordinator',
        leafId: 'leaf-coordinator',
        title: 'spinner title',
        connected: true,
        writable: true,
        lastOutputAt: null,
        preview: '',
        executionHostId: 'local'
      },
      {
        handle: 'term-unmanaged',
        ptyId: 'pty-unmanaged',
        worktreeId: 'folder:orchestration',
        worktreePath: '',
        branch: '',
        tabId: 'tab-unmanaged',
        leafId: 'leaf-unmanaged',
        title: 'Unmanaged',
        connected: true,
        writable: true,
        lastOutputAt: null,
        preview: '',
        executionHostId: 'local'
      }
    ],
    totalCount: 2,
    truncated: false
  }
}

function coordinatorLease(): MaestroTerminalLease {
  return {
    id: 'lease-coordinator',
    requestId: 'handoff-1',
    executionHostId: 'local',
    workspaceKey: scope.workspace_key,
    terminalHandle: 'term-coordinator',
    tabId: 'tab-coordinator',
    paneKey: 'pane-coordinator',
    ptyIncarnation: 'incarnation-1',
    processRootId: 'pty-coordinator',
    runId: 'run-1',
    taskId: null,
    attemptId: null,
    coordinatorGeneration: 2,
    role: 'coordinator',
    workerTerminalResourceId: null,
    coordinatorRunId: null,
    title: 'Harness · coordinator g2 · codex',
    launchProfile: {
      agent: 'codex',
      model: null,
      effort: null,
      permissionMode: 'default',
      routeRef: null
    },
    parentLeaseId: null,
    spawnedBy: 'coordinator',
    ownerPrincipal: 'coordinator:run-1:g2',
    retentionPolicy: 'auto_release',
    lifecycleState: 'active',
    observation: null,
    providerSessionId: null,
    capsuleDigest: null,
    cleanupReceipt: null,
    archivedTail: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  }
}

describe('Maestro workspace terminal inventory projection', () => {
  it('projects a live leased coordinator missing from the visual session', () => {
    const lease = coordinatorLease()
    const result = mergeMaestroWorkspaceTerminalInventory({
      scope,
      session: emptySession(),
      terminalList: terminalList(),
      getLease: (terminal) => (terminal.handle === lease.terminalHandle ? lease : undefined)
    })

    expect(result.session.tabs).toHaveLength(2)
    expect(result.session.tabs).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'tab-coordinator',
        terminal: 'term-coordinator',
        title: lease.title
      })
    )
    expect(result.session.tabGroups).toEqual([
      expect.objectContaining({ tabOrder: ['tab-coordinator', 'tab-unmanaged'] })
    ])
  })

  it('projects a live workspace terminal without a Harness lease', () => {
    const result = mergeMaestroWorkspaceTerminalInventory({
      scope,
      session: emptySession(),
      terminalList: terminalList(),
      getLease: () => undefined
    })

    expect(result.session.tabs).toHaveLength(2)
    expect(result.session.tabs).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'tab-unmanaged',
        terminal: 'term-unmanaged',
        title: 'Unmanaged'
      })
    )
  })

  it('projects the same leased process after its runtime handle is reminted', () => {
    const lease = {
      ...coordinatorLease(),
      terminalHandle: 'term-before-restart',
      ptyIncarnation: 'pty-coordinator:incarnation-1'
    }
    const result = mergeMaestroWorkspaceTerminalInventory({
      scope,
      session: emptySession(),
      terminalList: terminalList(),
      getLease: (terminal) => (terminal.tabId === lease.tabId ? lease : undefined)
    })

    expect(result.session.tabs).toHaveLength(2)
    expect(result.session.tabs).toContainEqual(
      expect.objectContaining({
        terminal: 'term-coordinator',
        parentTabId: lease.tabId,
        title: lease.title
      })
    )
  })
})
