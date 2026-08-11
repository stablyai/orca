import { describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeService } from './orca-runtime'

const GROUP_ID = 'shared-group'
const FOLDER_ID = 'shared-folder'
const SSH_TARGET_ID = 'ssh-1'

function group(connectionId: string | null): ProjectGroup {
  return {
    id: GROUP_ID,
    name: connectionId ? 'SSH group' : 'Local group',
    parentPath: connectionId ? '/srv/shared' : process.cwd(),
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
    folderPath: connectionId ? '/srv/shared/folder' : process.cwd(),
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

function runtimeFor(groups: ProjectGroup[], workspaces: FolderWorkspace[]): OrcaRuntimeService {
  return new OrcaRuntimeService({
    getRepos: () => [],
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => workspaces,
    getAllWorktreeMeta: () => ({}),
    getGitHubCache: () => undefined
  } as never)
}

describe('mobile folder workspace ownership', () => {
  it.each([false, true])(
    'publishes owner-qualified same-key rows without exposing a legacy collision (reversed=%s)',
    async (reversed) => {
      const localGroup = group(null)
      const sshGroup = group(SSH_TARGET_ID)
      const localWorkspace = workspace(null)
      const sshWorkspace = workspace(SSH_TARGET_ID)
      const groups = reversed ? [sshGroup, localGroup] : [localGroup, sshGroup]
      const workspaces = reversed ? [sshWorkspace, localWorkspace] : [localWorkspace, sshWorkspace]

      const runtime = runtimeFor(groups, workspaces)
      const legacy = await runtime.getWorktreePs(100)
      const ownerQualified = await runtime.getWorktreePs(100, { ownerQualified: true })
      const rows = ownerQualified.worktrees.filter(
        (candidate) => candidate.worktreeId === folderWorkspaceKey(FOLDER_ID)
      )

      expect(legacy.worktrees).toEqual([])
      expect(rows).toHaveLength(2)
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ hostId: 'local', path: process.cwd() }),
          expect.objectContaining({
            hostId: toSshExecutionHostId(SSH_TARGET_ID),
            path: '/srv/shared/folder'
          })
        ])
      )
    }
  )

  it.each([false, true])(
    'rejects an ownerless legacy launch selector (reversed=%s)',
    async (reversed) => {
      const groups = reversed
        ? [group(SSH_TARGET_ID), group(null)]
        : [group(null), group(SSH_TARGET_ID)]
      const workspaces = reversed
        ? [workspace(SSH_TARGET_ID), workspace(null)]
        : [workspace(null), workspace(SSH_TARGET_ID)]
      const runtime = runtimeFor(groups, workspaces) as unknown as {
        resolveFolderWorkspaceLaunchScope(selector: string): Promise<unknown>
      }

      await expect(
        runtime.resolveFolderWorkspaceLaunchScope(`id:${folderWorkspaceKey(FOLDER_ID)}`)
      ).rejects.toThrow('folder_workspace_connection_ambiguous')
    }
  )
})
