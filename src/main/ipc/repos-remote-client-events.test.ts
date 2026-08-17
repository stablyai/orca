/**
 * #11994: repo IPC mutations only sent `repos:changed` to the host's own renderer, so a
 * project deleted (or renamed/reordered) on the host stayed visible on every paired
 * client — clients refetch a remote catalog only on a `reposChanged` client event.
 * The broadcast lives in the shared `notifyReposChanged` helper so every repo mutation
 * fans out, and it must never be able to reject the IPC handler it runs inside.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReposModule from './repos'

const { handleMock, mockStore } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    getRepo: vi.fn(),
    addRepo: vi.fn(),
    updateRepo: vi.fn(),
    removeProject: vi.fn(),
    removeProjectForHost: vi.fn(),
    reorderRepos: vi.fn().mockReturnValue(true)
  }
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: handleMock, removeHandler: vi.fn() }
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([]),
  BASE_REF_SEARCH_ARGS: ['for-each-ref'],
  filterBaseRefSearchOutput: vi.fn().mockReturnValue([])
}))

vi.mock('./registered-worktree-roots-cache', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: vi.fn() }))
vi.mock('./ssh', () => ({ getActiveMultiplexer: vi.fn() }))

type HandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>

const handlers: HandlerMap = new Map()
const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }

/** Fresh module instance per test so the module-scoped notifier holder starts unset. */
async function registerHandlersWithoutNotifier(): Promise<typeof ReposModule> {
  vi.resetModules()
  const repos = await import('./repos')
  repos.registerRepoHandlers(mainWindow as never, mockStore as never)
  return repos
}

async function registerHandlersWithNotifier(
  notifyReposChangedForRemoteClients: () => void
): Promise<void> {
  const repos = await registerHandlersWithoutNotifier()
  repos.setRepoRemoteClientNotifier({ notifyReposChangedForRemoteClients } as never)
}

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  })
  mainWindow.webContents.send.mockReset()
  mockStore.removeProject.mockReset()
  mockStore.removeProjectForHost.mockReset()
  mockStore.reorderRepos.mockReset().mockReturnValue(true)
})

describe('repo IPC mutations notify paired clients', () => {
  it('broadcasts once for repos:remove and still notifies the local renderer', async () => {
    const notify = vi.fn()
    await registerHandlersWithNotifier(notify)

    await handlers.get('repos:remove')!(null, { repoId: 'repo-1' })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })

  it('broadcasts once for repos:removeForHost', async () => {
    const notify = vi.fn()
    await registerHandlersWithNotifier(notify)

    await handlers.get('repos:removeForHost')!(null, { repoId: 'repo-1', hostId: 'ssh:host-1' })

    expect(mockStore.removeProjectForHost).toHaveBeenCalledWith('repo-1', 'ssh:host-1')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('broadcasts for non-removal mutations too, via the shared helper', async () => {
    const notify = vi.fn()
    await registerHandlersWithNotifier(notify)

    handlers.get('repos:reorder')!(null, { orderedIds: ['repo-1', 'repo-2'] })

    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not throw when no notifier has been set', async () => {
    await registerHandlersWithoutNotifier()

    await expect(handlers.get('repos:remove')!(null, { repoId: 'repo-1' })).resolves.toBeUndefined()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })

  it('does not reject the handler when the notifier throws', async () => {
    await registerHandlersWithNotifier(() => {
      throw new Error('client event stream exploded')
    })

    await expect(handlers.get('repos:remove')!(null, { repoId: 'repo-1' })).resolves.toBeUndefined()
  })
})
