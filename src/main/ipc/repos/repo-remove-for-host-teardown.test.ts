import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))

vi.mock('../worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: vi.fn()
}))

const { registerRepoCatalogHandlers } = await import('./repo-catalog-handlers')

const repo = (fields: Partial<Repo>): Repo => ({
  id: 'repo-1',
  path: '/work/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  ...fields
})

function register(repos: Repo[]) {
  const store = { getRepos: () => repos, removeProjectForHost: vi.fn() }
  const runtime = { removeProject: vi.fn(async () => ({ removed: true as const })) }
  const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removeForHost reads only getRepos and removeProjectForHost.
  registerRepoCatalogHandlers(mainWindow as never, store as never, runtime)
  return { store, runtime, remove: handlers.get('repos:removeForHost')! }
}

describe('repos:removeForHost', () => {
  beforeEach(() => handlers.clear())

  it("removes this computer's project through the runtime, which stops its sessions first", async () => {
    const local = repo({})
    const ssh = repo({ executionHostId: 'ssh:box', connectionId: 'box' })
    const { store, runtime, remove } = register([local, ssh])
    await remove(null, { repoId: 'repo-1', hostId: 'ssh:box' })
    expect(runtime.removeProject).toHaveBeenCalledWith(ssh)
    expect(store.removeProjectForHost).not.toHaveBeenCalled()
  })

  it("only drops a paired server's residue row, which runs nothing here", async () => {
    const paired = repo({ executionHostId: 'runtime:env-1' })
    const { store, runtime, remove } = register([paired])
    await remove(null, { repoId: 'repo-1', hostId: 'runtime:env-1' })
    expect(runtime.removeProject).not.toHaveBeenCalled()
    expect(store.removeProjectForHost).toHaveBeenCalledWith({
      id: 'repo-1',
      executionHostId: 'runtime:env-1'
    })
  })
})
