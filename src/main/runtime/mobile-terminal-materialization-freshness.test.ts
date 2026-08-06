import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { FolderWorkspace, ProjectGroup, WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
    BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
    ipcMain,
    Notification: vi.fn(),
    webContents: { fromId: vi.fn(() => null) }
  }
})

vi.mock('electron', () => electronMocks)

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'

function createSession(worktreeId: string, ptyId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: worktreeId,
    activeTabId: TAB_ID,
    activeTabIdByWorktree: { [worktreeId]: TAB_ID },
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: TAB_ID,
          ptyId,
          worktreeId,
          title: 'Persisted terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, LEAF_ID)]: '33333333-3333-4333-8333-333333333333'
    }
  }
}

function createFixture(connectionId: string | null) {
  const folder: FolderWorkspace = {
    id: 'freshness-folder',
    projectGroupId: 'freshness-group',
    name: 'Freshness folder',
    folderPath: '/workspace/freshness',
    connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const group: ProjectGroup = {
    id: folder.projectGroupId,
    name: folder.projectGroupId,
    parentPath: folder.folderPath,
    connectionId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const worktreeId = `folder:${folder.id}`
  const ptyId = connectionId
    ? `ssh:${connectionId}@@persisted-freshness-pty`
    : 'persisted-freshness-pty'
  const folders = [folder]
  let session = createSession(worktreeId, ptyId)
  const runtime = new OrcaRuntimeService({
    getRepo: () => undefined,
    getRepos: () => [],
    getFolderWorkspaces: () => folders,
    getProjectGroups: () => [group],
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: () => [
      folders[0]!.connectionId ? `ssh:${folders[0]!.connectionId}` : 'local'
    ],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    setWorktreeMeta: () => undefined as never,
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: '/workspace',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  } as never)
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: () => Promise<{
        id: string
        path: string
        connectionId: string | null
        repo: null
        folderWorkspace: FolderWorkspace
      }>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockImplementation(async () => ({
    id: worktreeId,
    path: folders[0]!.folderPath,
    connectionId: folders[0]!.connectionId ?? null,
    repo: null,
    folderWorkspace: folders[0]!
  }))
  const pending: {
    resolve: (result: { id: string; spawnDisposition: 'reattached' }) => void
    reject: (error: Error) => void
  }[] = []
  const spawn = vi.fn(
    () =>
      new Promise<{ id: string; spawnDisposition: 'reattached' }>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
  )
  const kill = vi.fn(() => true)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  return { runtime, folders, folder, worktreeId, ptyId, pending, spawn, kill }
}

describe('mobile terminal materialization freshness', () => {
  it('bypasses an obsolete reconnect rejection for a current activation', async () => {
    const connectionId = 'freshness-ssh'
    const fixture = createFixture(connectionId)
    const focusTerminal = vi.fn()
    fixture.runtime.setNotifier({ focusTerminal } as never)
    const stale = fixture.runtime.activateMobileSessionTab(`id:${fixture.worktreeId}`, TAB_ID)
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce())

    fixture.runtime.notifySshStateChanged(connectionId, {
      targetId: connectionId,
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    })
    const current = fixture.runtime.activateMobileSessionTab(`id:${fixture.worktreeId}`, TAB_ID)
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledTimes(2))

    fixture.pending[0]!.reject(new Error('obsolete reconnect'))
    await expect(stale).rejects.toThrow('obsolete reconnect')
    expect(focusTerminal).not.toHaveBeenCalled()

    fixture.pending[1]!.resolve({ id: fixture.ptyId, spawnDisposition: 'reattached' })
    await expect(current).resolves.toMatchObject({ activeTabId: `${TAB_ID}::${LEAF_ID}` })
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('bypasses an obsolete folder-routing rejection without unfencing its caller', async () => {
    const fixture = createFixture(null)
    const focusTerminal = vi.fn()
    fixture.runtime.setNotifier({ focusTerminal } as never)
    const stale = fixture.runtime.activateMobileSessionTab(`id:${fixture.worktreeId}`, TAB_ID)
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce())

    fixture.folders[0] = {
      ...fixture.folder,
      folderPath: '/workspace/freshness-moved',
      connectionId: 'freshness-route'
    }
    const current = fixture.runtime.activateMobileSessionTab(`id:${fixture.worktreeId}`, TAB_ID)
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledTimes(2))

    fixture.pending[0]!.reject(new Error('obsolete folder route'))
    await expect(stale).rejects.toThrow('obsolete folder route')
    expect(focusTerminal).not.toHaveBeenCalled()

    fixture.pending[1]!.resolve({ id: fixture.ptyId, spawnDisposition: 'reattached' })
    await expect(current).resolves.toMatchObject({ activeTabId: `${TAB_ID}::${LEAF_ID}` })
    expect(fixture.spawn).toHaveBeenCalledTimes(2)
  })
})
