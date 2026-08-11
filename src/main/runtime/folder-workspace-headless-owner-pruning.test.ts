import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type {
  FolderWorkspace,
  ProjectGroup,
  Repo,
  TerminalLayoutSnapshot
} from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { IPtyProvider } from '../providers/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { OrcaRuntimeService } from './orca-runtime'

const GROUP_ID = 'group-1'

function makeGroup(connectionId: string | null): ProjectGroup {
  return {
    id: GROUP_ID,
    name: GROUP_ID,
    parentPath: '/workspace',
    connectionId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeWorkspace(id: string, connectionId: string | null): FolderWorkspace {
  return {
    id,
    projectGroupId: GROUP_ID,
    name: id,
    folderPath: `/workspace/${id}`,
    connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeRepo(connectionId: string): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/repo-1',
    displayName: 'repo-1',
    badgeColor: '#737373',
    addedAt: 1,
    projectGroupId: GROUP_ID,
    connectionId
  }
}

function createRuntime(args: {
  groups: ProjectGroup[]
  workspaces: FolderWorkspace[]
  repos?: Repo[]
}) {
  let workspaces = [...args.workspaces]
  const removeFolderWorkspace = vi.fn(
    (
      workspaceId: string,
      options: { executionHostId?: ExecutionHostId; preserveRendererWorkspaceKey?: boolean } = {}
    ) => {
      const matches = workspaces.filter(
        (workspace) =>
          workspace.id === workspaceId &&
          (!options.executionHostId ||
            (workspace.connectionId
              ? toSshExecutionHostId(workspace.connectionId)
              : LOCAL_EXECUTION_HOST_ID) === options.executionHostId)
      )
      if (matches.length !== 1) {
        return false
      }
      workspaces = workspaces.filter((workspace) => workspace !== matches[0])
      return true
    }
  )
  const localProvider = {
    listProcesses: vi.fn(async () => []),
    shutdown: vi.fn(async () => {})
  } as unknown as IPtyProvider
  const sshProvider = {
    listProcesses: vi.fn(async () => []),
    shutdown: vi.fn(async () => {})
  } as unknown as IPtyProvider
  const createFolderWorkspace = vi.fn(
    (input: {
      projectGroupId: string
      folderPath?: string | null
      connectionId?: string | null
    }) => {
      const workspace = {
        ...makeWorkspace('created-folder', input.connectionId ?? null),
        projectGroupId: input.projectGroupId,
        folderPath: input.folderPath ?? '/workspace/created-folder'
      }
      workspaces.push(workspace)
      return workspace
    }
  )
  const runtime = new OrcaRuntimeService(
    {
      getRepos: () => args.repos ?? [],
      getProjectGroups: () => args.groups,
      getFolderWorkspaces: () => workspaces,
      createFolderWorkspace,
      removeFolderWorkspace,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => ({}),
      removeWorktreeMeta: () => false,
      getSettings: () => ({})
    } as never,
    undefined,
    {
      getLocalProvider: () => localProvider,
      getSshProvider: () => sshProvider
    }
  )
  return { runtime, createFolderWorkspace, removeFolderWorkspace }
}

describe('headless folder workspace owner pruning', () => {
  it('prunes only the deleted SSH owner from a shared mobile split after verified shutdown', async () => {
    const workspaceId = 'shared-headless-folder'
    const workspaceKey = folderWorkspaceKey(workspaceId)
    const connectionId = 'ssh-owner'
    const localWorkspace = makeWorkspace(workspaceId, null)
    const sshWorkspace = makeWorkspace(workspaceId, connectionId)
    const fixture = createRuntime({
      groups: [makeGroup(null), makeGroup(connectionId)],
      workspaces: [localWorkspace, sshWorkspace]
    })
    const localPtyId = `${workspaceKey}@@local-survivor`
    const sshPtyId = `ssh:${connectionId}@@deleted-owner`
    const layout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', leafId: 'local-leaf' },
        second: { type: 'leaf', leafId: 'ssh-leaf' }
      },
      activeLeafId: 'ssh-leaf',
      expandedLeafId: 'ssh-leaf',
      ptyIdsByLeafId: { 'local-leaf': localPtyId, 'ssh-leaf': sshPtyId },
      buffersByLeafId: { 'local-leaf': 'local-buffer', 'ssh-leaf': 'ssh-buffer' },
      scrollbackRefsByLeafId: { 'local-leaf': 'local-ref', 'ssh-leaf': 'ssh-ref' },
      titlesByLeafId: { 'local-leaf': 'Local', 'ssh-leaf': 'SSH' }
    }
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: workspaceKey,
      publicationEpoch: 'renderer:headless-owner-pruning',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: 'shared::ssh-leaf',
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: 'shared::local-leaf',
          parentTabId: 'shared',
          leafId: 'local-leaf',
          ptyId: localPtyId,
          title: 'Local',
          parentLayout: layout,
          isActive: false
        },
        {
          type: 'terminal',
          id: 'shared::ssh-leaf',
          parentTabId: 'shared',
          leafId: 'ssh-leaf',
          ptyId: sshPtyId,
          title: 'SSH',
          parentLayout: layout,
          isActive: true
        }
      ]
    }
    fixture.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    fixture.runtime.registerPty(localPtyId, workspaceKey, null)
    fixture.runtime.registerPty(sshPtyId, workspaceKey, connectionId)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      fixture.runtime.onPtyExit(ptyId, 0)
      return true
    })
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    const internals = fixture.runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      ptysById: Map<string, unknown>
    }
    internals.mobileSessionTabsByWorktree.set(workspaceKey, snapshot)

    await expect(
      fixture.runtime.deleteFolderWorkspace(workspaceId, {
        executionHostId: toSshExecutionHostId(connectionId)
      })
    ).resolves.toEqual({ deleted: true })

    const stored = internals.mobileSessionTabsByWorktree.get(workspaceKey)!
    expect(stopAndWait).toHaveBeenCalledWith(sshPtyId, expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalledWith(localPtyId, expect.anything())
    expect(stored.snapshotVersion).toBe(2)
    expect(stored).toMatchObject({
      activeTabId: 'shared::local-leaf',
      activeTabType: 'terminal'
    })
    expect(stored.tabs.map((tab) => tab.id)).toEqual(['shared::local-leaf'])
    expect(stored.tabs[0]).toMatchObject({
      isActive: true,
      parentLayout: {
        root: { type: 'leaf', leafId: 'local-leaf' },
        activeLeafId: 'local-leaf',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'local-leaf': localPtyId },
        buffersByLeafId: { 'local-leaf': 'local-buffer' },
        scrollbackRefsByLeafId: { 'local-leaf': 'local-ref' },
        titlesByLeafId: { 'local-leaf': 'Local' }
      }
    })
    expect(internals.ptysById.has(localPtyId)).toBe(true)
  })

  it('treats an explicit-null workspace as local under a sole SSH group', async () => {
    const workspace = makeWorkspace('explicit-local', null)
    const fixture = createRuntime({
      groups: [makeGroup('ssh-group')],
      workspaces: [workspace],
      repos: [makeRepo('ssh-group')]
    })

    const release = await fixture.runtime.acquireWorktreeTerminalSpawn(
      folderWorkspaceKey(workspace.id),
      { executionHostId: LOCAL_EXECUTION_HOST_ID, connectionId: null }
    )
    release()
  })

  it('rejects an explicit-null create request under a sole SSH group', async () => {
    const connectionId = 'ssh-create-group'
    const root = await mkdtemp(join(tmpdir(), 'orca-explicit-local-create-'))
    const sshStat = vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 1 })
    registerSshFilesystemProvider(connectionId, { stat: sshStat } as never)
    try {
      const fixture = createRuntime({
        groups: [makeGroup(connectionId)],
        workspaces: [],
        repos: [makeRepo(connectionId)]
      })

      await expect(
        fixture.runtime.createFolderWorkspace({
          projectGroupId: GROUP_ID,
          folderPath: root,
          connectionId: null
        })
      ).rejects.toThrow('folder_workspace_project_group_not_found')
      expect(sshStat).not.toHaveBeenCalled()
      expect(fixture.createFolderWorkspace).not.toHaveBeenCalled()
    } finally {
      unregisterSshFilesystemProvider(connectionId)
      await rm(root, { recursive: true, force: true })
    }
  })
})
