import { describe, expect, it, vi } from 'vitest'
import { WslHostWindowsDriveRefusalError } from '../../shared/wsl-host-windows-drive-refusal'
import type { Repo } from '../../shared/repo-types'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import type { RuntimeStore } from './runtime-store-contract'

// Stands in for a WSL host whose /mnt/c is the C: drive; SSH and desktop never refuse.
const guard = vi.hoisted(() => ({
  refuse: vi.fn(async (path: string) => {
    if (path.startsWith('/mnt/c')) {
      throw new WslHostWindowsDriveRefusalError(`C:\\${path.slice('/mnt/c/'.length)}`)
    }
  })
}))
vi.mock('./wsl-host-windows-drive-guard', () => ({
  refuseWslHostWindowsDrivePath: guard.refuse
}))

const unused = (): never => {
  throw new Error('unused')
}

function storeWith(overrides: Partial<RuntimeStore> = {}): RuntimeStore {
  return {
    getRepos: () => [],
    getRepo: unused,
    addRepo: unused,
    updateRepo: unused,
    getAllWorktreeMeta: unused,
    getWorktreeMeta: unused,
    setWorktreeMeta: unused,
    removeWorktreeMeta: unused,
    getGitHubCache: unused,
    getSettings: unused,
    ...overrides
  }
}

const deps = {
  invalidateResolvedWorktrees: () => {},
  invalidateWorktreeScan: () => {},
  notifyReposChanged: () => {}
}

describe('WSL host backstop for Windows drive projects', () => {
  it('refuses a clone into a drive folder before cloning or storing anything', async () => {
    const addRepo = vi.fn<(repo: Repo) => void>()
    const controller = new RuntimeRepositoryCloneController({
      ...deps,
      getStore: () => storeWith({ addRepo })
    })
    await expect(
      controller.clone('https://example.com/acme/app.git', '/mnt/c/src')
    ).rejects.toBeInstanceOf(WslHostWindowsDriveRefusalError)
    expect(addRepo).not.toHaveBeenCalled()
  })

  it('returns a create refusal with its typed detail, so the dialog can offer this computer', async () => {
    const controller = new RuntimeRepositoryRegistrationController({
      ...deps,
      getStore: () => storeWith()
    })
    await expect(controller.create('/mnt/c/src', 'app')).resolves.toEqual({
      error: expect.stringContaining('C:\\src'),
      windowsDriveRefusal: { kind: 'wsl_host_windows_drive_path', windowsPath: 'C:\\src' }
    })
  })

  it('refuses an explicit folder workspace path on a drive, and leaves the group folder alone', async () => {
    const createFolderWorkspace = vi.fn<NonNullable<RuntimeStore['createFolderWorkspace']>>()
    const store = storeWith({
      createFolderWorkspace,
      getProjectGroups: () => [
        {
          id: 'group-1',
          name: 'Notes',
          parentPath: '/home/me/notes',
          connectionId: null,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const controller = new RuntimeProjectGroupController({
      getStore: () => store,
      resolveRepo: unused,
      notifyReposChanged: () => {},
      resolveFolderConnectionId: () => null,
      teardownFolderWorkspacePtys: async () => undefined,
      cleanupRemovedFolderWorkspaceState: () => undefined,
      emitWorktreeLifecycle: () => undefined
    })

    await expect(
      controller.createFolderWorkspace({ projectGroupId: 'group-1', folderPath: '/mnt/c/notes' })
    ).rejects.toBeInstanceOf(WslHostWindowsDriveRefusalError)
    expect(createFolderWorkspace).not.toHaveBeenCalled()

    guard.refuse.mockClear()
    await controller.createFolderWorkspace({ projectGroupId: 'group-1' }).catch(() => undefined)
    expect(guard.refuse).not.toHaveBeenCalled()
  })
})
