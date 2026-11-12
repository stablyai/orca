/** Paired clients refetch only on reposChanged; broadcast failures must not reject committed mutations. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReposChangedNotificationModule from './repos/repos-changed-notification'

const { handleMock, mockStore } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    getRepo: vi.fn(),
    addRepo: vi.fn(),
    updateRepo: vi.fn(),
    removeProjectForHost: vi.fn(),
    reorderRepos: vi.fn().mockReturnValue(true)
  }
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: handleMock, removeHandler: vi.fn() }
}))

vi.mock('../git/repositories/discovery/repo-detection', () => ({
  isGitRepo: vi.fn().mockReturnValue(true)
}))
vi.mock('../git/repositories/repository-name', () => ({
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop())
}))
vi.mock('../git/refs/resolution/repo-default-base-ref', () => ({
  getDefaultBaseRefAsync: vi.fn().mockResolvedValue('origin/main')
}))
vi.mock('../git/refs/resolution/repo-base-ref-search', () => ({
  searchBaseRefs: vi.fn().mockResolvedValue([])
}))

vi.mock('./worktrees/removal/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn(),
  invalidateAuthorizedRootsCacheForRepo: vi.fn()
}))

type HandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>

const handlers: HandlerMap = new Map()
const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }

/** Fresh module instance per test so the module-scoped notifier holder starts unset. */
async function registerHandlersWithoutNotifier(): Promise<typeof ReposChangedNotificationModule> {
  vi.resetModules()
  const repos = await import('./repos')
  repos.registerRepoHandlers(mainWindow as never, mockStore as never, {} as never)
  return import('./repos/repos-changed-notification')
}

async function registerHandlersWithNotifier(
  notifyReposChangedForRemoteClients: () => void
): Promise<void> {
  const notification = await registerHandlersWithoutNotifier()
  notification.setRepoRemoteClientNotifier({ notifyReposChangedForRemoteClients } as never)
}

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  })
  mainWindow.webContents.send.mockReset()
  mockStore.removeProjectForHost.mockReset()
  mockStore.reorderRepos.mockReset().mockReturnValue(true)
})

describe('repo IPC mutations notify paired clients', () => {
  it('does not reject the handler when the notifier throws', async () => {
    await registerHandlersWithNotifier(() => {
      throw new Error('client event stream exploded')
    })

    await expect(
      handlers.get('repos:removeForHost')!(null, { repoId: 'repo-1', hostId: 'local' })
    ).resolves.toBeUndefined()
  })
})
