import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup, WorkspaceSessionState } from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeService } from './orca-runtime'

const GROUP_ID = 'shared-group'
const FOLDER_ID = 'shared-folder'
const SSH_TARGET_ID = 'builder'
const SSH_HOST_ID = toSshExecutionHostId(SSH_TARGET_ID)

function group(connectionId: string | null): ProjectGroup {
  return {
    id: GROUP_ID,
    name: connectionId ? 'SSH' : 'Local',
    parentPath: connectionId ? '/remote/group' : '/local/group',
    connectionId,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function workspace(connectionId: string | null): FolderWorkspace {
  return {
    id: FOLDER_ID,
    projectGroupId: GROUP_ID,
    name: connectionId ? 'SSH folder' : 'Local folder',
    folderPath: connectionId ? '/remote/group/folder' : '/local/group/folder',
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

function session(tabId: string): WorkspaceSessionState {
  const worktreeId = folderWorkspaceKey(FOLDER_ID)
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [{ id: tabId, worktreeId, title: tabId }]
    } as WorkspaceSessionState['tabsByWorktree']
  }
}

function runtimeFor(reversed: boolean): OrcaRuntimeService {
  const localGroup = group(null)
  const sshGroup = group(SSH_TARGET_ID)
  const localWorkspace = workspace(null)
  const sshWorkspace = workspace(SSH_TARGET_ID)
  const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
    ['local', session('local-tab')],
    [SSH_HOST_ID, session('ssh-tab')]
  ])
  return new OrcaRuntimeService({
    getRepos: () => [],
    getProjectGroups: () => (reversed ? [sshGroup, localGroup] : [localGroup, sshGroup]),
    getFolderWorkspaces: () =>
      reversed ? [sshWorkspace, localWorkspace] : [localWorkspace, sshWorkspace],
    getWorkspaceSessionHostIds: () => [...sessions.keys()],
    getWorkspaceSession: (hostId?: ExecutionHostId) => sessions.get(hostId ?? 'local')
  } as never)
}

describe('same-ID folder owner collisions', () => {
  it.each([false, true])('does not cross-route session state (reversed=%s)', (reversed) => {
    const runtime = runtimeFor(reversed) as unknown as {
      tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null
      getWorkspaceSessionHydrationTargets(
        includeAllPersistedWorktrees: boolean
      ): Map<string, WorkspaceSessionState>
    }
    const workspaceKey = folderWorkspaceKey(FOLDER_ID)

    expect(runtime.tryGetWorkspaceSessionHostIdForWorktree(workspaceKey)).toBeNull()
    expect([...runtime.getWorkspaceSessionHydrationTargets(true)]).toEqual([])
  })

  it.each([false, true])('rejects an ambiguous lineage parent (reversed=%s)', async (reversed) => {
    const runtime = runtimeFor(reversed) as unknown as {
      resolveWorkspaceParentSelector(selector: string): Promise<unknown>
    }

    await expect(
      runtime.resolveWorkspaceParentSelector(folderWorkspaceKey(FOLDER_ID))
    ).rejects.toThrow('selector_ambiguous')
  })
})
