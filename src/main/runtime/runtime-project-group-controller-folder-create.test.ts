import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { RuntimeStore } from './runtime-store-contract'
import { FolderWorkspaceCreateRefusedError } from '../project-groups/folder-workspace-create-refusal'

const MISSING_PATH = join(tmpdir(), 'orca-folder-create-missing-9c1f')

// The store members a folder create never reaches.
const unused = (): never => {
  throw new Error('unused')
}

function createController() {
  const createFolderWorkspace = vi.fn<NonNullable<RuntimeStore['createFolderWorkspace']>>()
  const notifyReposChanged = vi.fn()
  const store: RuntimeStore = {
    getProjectGroups: () => [
      {
        id: 'group-1',
        name: 'Notes',
        parentPath: MISSING_PATH,
        connectionId: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    getRepos: () => [],
    createFolderWorkspace,
    getRepo: unused,
    addRepo: unused,
    updateRepo: unused,
    getAllWorktreeMeta: unused,
    getWorktreeMeta: unused,
    setWorktreeMeta: unused,
    removeWorktreeMeta: unused,
    getGitHubCache: unused,
    getSettings: unused
  }
  const controller = new RuntimeProjectGroupController({
    getStore: () => store,
    resolveRepo: async () => {
      throw new Error('unused')
    },
    notifyReposChanged,
    resolveFolderConnectionId: () => null,
    teardownFolderWorkspacePtys: async () => undefined,
    cleanupRemovedFolderWorkspaceState: () => undefined
  })
  return { controller, createFolderWorkspace, notifyReposChanged }
}

// A launch reads these as "nothing was created", so each must come before the store write and keep
// the code `folderWorkspace.create` has always answered with.
describe('RuntimeProjectGroupController.createFolderWorkspace refusals', () => {
  it.each([
    ['a group that is gone', 'group-2', 'folder_workspace_project_group_not_found'],
    ['a folder that is missing', 'group-1', `folder_workspace_path_missing:${MISSING_PATH}`]
  ])('refuses %s as a typed refusal without storing anything', async (_case, groupId, code) => {
    const deps = createController()

    const refused = deps.controller.createFolderWorkspace({ projectGroupId: groupId })

    await expect(refused).rejects.toBeInstanceOf(FolderWorkspaceCreateRefusedError)
    await expect(refused).rejects.toMatchObject({ message: code })
    expect(deps.createFolderWorkspace).not.toHaveBeenCalled()
    expect(deps.notifyReposChanged).not.toHaveBeenCalled()
  })
})
