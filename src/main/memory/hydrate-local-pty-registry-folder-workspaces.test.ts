import { beforeEach, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { SessionInfo } from '../daemon/types'
import type { Store } from '../persistence'

const getDaemonProviderMock = vi.fn()
vi.mock('../daemon/daemon-init', () => ({
  getDaemonProvider: () => getDaemonProviderMock()
}))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
const listLocalRepoWorktreesStrictMock = vi.fn()
vi.mock('../repo-worktrees', () => ({
  listLocalRepoWorktreesStrict: (...args: unknown[]) => listLocalRepoWorktreesStrictMock(...args)
}))

function makeStore(folderWorkspaces: FolderWorkspace[]): Store {
  const store: Partial<Store> = {
    getRepos: () => [],
    getFolderWorkspaces: () => folderWorkspaces,
    getProjectGroups: () => [],
    getAllWorktreeMeta: () => ({}),
    getAllWorktreeMetaForHost: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hydration reads only the store members stubbed here.
  return store as Store
}

// Why fresh modules: the hydrator memoizes its pass and the registry is module-scoped.
async function loadFresh() {
  vi.resetModules()
  const hydrateMod = await import('./hydrate-local-pty-registry')
  const registryMod = await import('./pty-registry')
  return {
    hydrate: hydrateMod.hydrateLocalPtyRegistryAtBoot,
    listRegisteredPtys: registryMod.listRegisteredPtys
  }
}

beforeEach(() => {
  getDaemonProviderMock.mockReset()
  listLocalRepoWorktreesStrictMock.mockReset()
})

it('hydrates surviving true folder workspace PTYs without enumerating Git', async () => {
  const { hydrate, listRegisteredPtys } = await loadFresh()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership reads only id and executionHostId.
  const workspace = { id: 'folder-workspace-1', executionHostId: 'local' } as FolderWorkspace
  const session = { sessionId: 'folder:folder-workspace-1@@cafebabe', pid: 4242 }
  getDaemonProviderMock.mockReturnValue({ listSessions: vi.fn().mockResolvedValue([session]) })

  await hydrate(makeStore([workspace]))

  expect(listRegisteredPtys()).toEqual([
    expect.objectContaining({
      ptyId: 'folder:folder-workspace-1@@cafebabe',
      worktreeId: 'folder:folder-workspace-1',
      pid: 4242
    })
  ])
  expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
})

it.each(['deleted', 'remote', 'ssh'] as const)(
  'rechecks folder ownership after inventory when the catalog becomes %s',
  async (change) => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership reads only id and executionHostId.
    const folders = [{ id: 'folder-1', executionHostId: 'local' } as FolderWorkspace]
    getDaemonProviderMock.mockReturnValue({
      listSessions: vi.fn().mockImplementation(async (): Promise<Partial<SessionInfo>[]> => {
        if (change === 'deleted') {
          folders.splice(0)
        } else {
          folders[0].executionHostId = change === 'ssh' ? 'ssh:target-1' : 'runtime:environment-1'
        }
        return [{ sessionId: 'folder:folder-1@@cafebabe', pid: 4242 }]
      })
    })

    await hydrate(makeStore(folders))

    expect(listRegisteredPtys()).toEqual([])
    expect(listLocalRepoWorktreesStrictMock).not.toHaveBeenCalled()
  }
)
