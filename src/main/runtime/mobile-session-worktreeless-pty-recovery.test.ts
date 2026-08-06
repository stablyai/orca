import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { FolderWorkspace, ProjectGroup, WorkspaceSessionState } from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
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

const INCARNATION_ID = '55555555-5555-4555-8555-555555555555'
const LEAF_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function makeFolder(
  id: string,
  groupId: string,
  connectionId: string,
  hostId: ExecutionHostId
): FolderWorkspace {
  return {
    id,
    projectGroupId: groupId,
    name: id,
    folderPath: `/workspace/${id}`,
    connectionId,
    executionHostId: hostId,
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
}

function makeGroup(id: string, connectionId: string, hostId: ExecutionHostId): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: `/workspace/${id}`,
    connectionId,
    executionHostId: hostId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function addOwnerEvidence(
  session: WorkspaceSessionState,
  ownerSource: 'unified' | 'active' | 'sleeping' | 'surface',
  worktreeId: ReturnType<typeof folderWorkspaceKey>,
  tabId: string,
  ptyId: string,
  connectionId: string
): void {
  const paneKey = makePaneKey(tabId, LEAF_ID)
  if (ownerSource === 'unified') {
    session.unifiedTabs = {
      [worktreeId]: [
        {
          id: tabId,
          entityId: tabId,
          groupId: 'group',
          worktreeId,
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  } else if (ownerSource === 'active') {
    session.activeWorkspaceKey = worktreeId
    session.activeWorktreeId = worktreeId
    session.activeTabId = tabId
  } else if (ownerSource === 'sleeping') {
    session.sleepingAgentSessionsByPaneKey = {
      [paneKey]: {
        paneKey,
        tabId,
        worktreeId,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'session' },
        prompt: 'Continue',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        connectionId
      }
    }
  } else {
    session.terminalSurfaceTombstonesByPaneKey = {
      [paneKey]: {
        worktreeId,
        parentTabId: tabId,
        leafId: LEAF_ID,
        ptyId,
        incarnationId: INCARNATION_ID,
        retiredAt: 1
      }
    }
  }
  session.terminalLayoutsByTabId[tabId] = {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: ptyId }
  }
  session.terminalPtyIncarnationsByPaneKey = { [paneKey]: INCARNATION_ID }
}

function createWorktreelessRecoveryRuntime(args: {
  folders: FolderWorkspace[]
  groups: ProjectGroup[]
  sessions: Map<ExecutionHostId, WorkspaceSessionState>
}): OrcaRuntimeService {
  return new OrcaRuntimeService({
    getRepo: () => undefined,
    getRepos: () => [],
    getFolderWorkspaces: () => args.folders,
    getProjectGroups: () => args.groups,
    getWorkspaceSession: (hostId?: string | null) =>
      args.sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
    getWorkspaceSessionHostIds: () => [...args.sessions.keys()],
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
}

describe('worktree-less mobile PTY recovery', () => {
  it.each([
    ['unified', 'relay'],
    ['active', 'app'],
    ['sleeping', 'relay'],
    ['surface', 'relay']
  ] as const)(
    'recovers runtime folder ownership from %s evidence with a %s persisted id',
    async (ownerSource, persistedIdKind) => {
      const connectionId = `missing-owner-${ownerSource}`
      const runtimeHostId = toRuntimeExecutionHostId(connectionId)
      const groupId = `${connectionId}-group`
      const folder = makeFolder(connectionId, groupId, connectionId, runtimeHostId)
      const group = makeGroup(groupId, connectionId, runtimeHostId)
      const worktreeId = folderWorkspaceKey(folder.id)
      const tabId = `tab-${ownerSource}`
      const relayPtyId = `relay-pty-${ownerSource}`
      const appPtyId = `ssh:${connectionId}@@${relayPtyId}`
      const persistedPtyId = persistedIdKind === 'app' ? appPtyId : relayPtyId
      const controllerPtyId = persistedIdKind === 'app' ? relayPtyId : appPtyId
      const session = getDefaultWorkspaceSession()
      addOwnerEvidence(session, ownerSource, worktreeId, tabId, persistedPtyId, connectionId)
      const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
        ['local', getDefaultWorkspaceSession()],
        [toSshExecutionHostId(connectionId), getDefaultWorkspaceSession()],
        [runtimeHostId, session]
      ])
      const runtime = createWorktreelessRecoveryRuntime({
        folders: [folder],
        groups: [group],
        sessions
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [
          {
            id: controllerPtyId,
            cwd: folder.folderPath,
            title: ownerSource,
            terminalHandle: `term_${ownerSource}`,
            incarnationId: INCARNATION_ID
          }
        ]
      })

      await (
        runtime as unknown as {
          refreshPtyWorktreeRecordsWithControllerInventory: (
            worktrees: [],
            targetWorktreeId: null,
            deadline: undefined,
            connectionId: string
          ) => Promise<unknown>
        }
      ).refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, connectionId)

      const internals = runtime as unknown as {
        ptysById: Map<string, { worktreeId: string; tabId: string | null; paneKey: string | null }>
        handleByPtyId: Map<string, string>
      }
      expect(internals.ptysById.get(controllerPtyId)?.worktreeId).toBe(worktreeId)
      if (ownerSource === 'surface') {
        expect(internals.ptysById.get(controllerPtyId)).toMatchObject({
          tabId: null,
          paneKey: null
        })
      } else {
        expect(internals.ptysById.get(controllerPtyId)).toMatchObject({
          tabId,
          paneKey: makePaneKey(tabId, LEAF_ID)
        })
        expect(internals.handleByPtyId.get(controllerPtyId)).toBe(`term_${ownerSource}`)
      }
    }
  )

  it('rejects a raw alias owner when the equivalent scoped PTY id is ambiguous', async () => {
    const connectionId = 'alias-collision-relay'
    const hostId = toRuntimeExecutionHostId('alias-collision-owner')
    const relayPtyId = 'alias-collision-pty'
    const appPtyId = `ssh:${connectionId}@@${relayPtyId}`
    const group = makeGroup('alias-collision-group', connectionId, hostId)
    const folders = ['raw-owner', 'scoped-owner-a', 'scoped-owner-b'].map((id) =>
      makeFolder(id, group.id, connectionId, hostId)
    )
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree = Object.fromEntries(
      folders.map((folder, index) => {
        const worktreeId = folderWorkspaceKey(folder.id)
        return [
          worktreeId,
          [
            {
              id: `alias-collision-tab-${index}`,
              ptyId: index === 0 ? relayPtyId : appPtyId,
              worktreeId,
              title: folder.id,
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        ]
      })
    )
    const runtime = createWorktreelessRecoveryRuntime({
      folders,
      groups: [group],
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [hostId, session]
      ])
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: relayPtyId, cwd: '/unknown', title: 'Ambiguous alias' }]
    })

    await (
      runtime as unknown as {
        refreshPtyWorktreeRecordsWithControllerInventory: (
          worktrees: [],
          targetWorktreeId: null,
          deadline: undefined,
          connectionId: string
        ) => Promise<unknown>
      }
    ).refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, connectionId)

    const ptysById = (runtime as unknown as { ptysById: Map<string, { worktreeId: string }> })
      .ptysById
    expect(ptysById.has(relayPtyId)).toBe(false)
  })
})
