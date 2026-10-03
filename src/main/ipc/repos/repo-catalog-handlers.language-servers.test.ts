import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  disposeForRepo: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))
vi.mock('../registered-worktree-roots-cache', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
vi.mock('../../lsp/lsp-session-registry', () => ({
  getLspSessionManager: () => ({ disposeForRepo: mocks.disposeForRepo })
}))

import { registerRepoCatalogHandlers } from './repo-catalog-handlers'

describe('repo removal stops language servers', () => {
  const store = { removeProject: vi.fn(), removeProjectForHost: vi.fn() }
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.disposeForRepo.mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal handlers only call these two store methods.
    registerRepoCatalogHandlers({} as never, store as never)
  })

  it('disposes the repo sessions after repos:remove', async () => {
    await mocks.handlers.get('repos:remove')?.({}, { repoId: 'r1' })
    expect(store.removeProject).toHaveBeenCalledWith('r1')
    expect(mocks.disposeForRepo).toHaveBeenCalledWith('r1')
  })

  it('disposes on a local repos:removeForHost but not a remote one', async () => {
    await mocks.handlers.get('repos:removeForHost')?.({}, { repoId: 'r1', hostId: 'ssh:box' })
    expect(mocks.disposeForRepo).not.toHaveBeenCalled()
    await mocks.handlers.get('repos:removeForHost')?.({}, { repoId: 'r1', hostId: 'local' })
    expect(mocks.disposeForRepo).toHaveBeenCalledWith('r1')
  })

  it('does not dispose when removal throws', async () => {
    store.removeProject.mockImplementationOnce(() => {
      throw new Error('nope')
    })
    await expect(mocks.handlers.get('repos:remove')?.({}, { repoId: 'r1' })).rejects.toThrow()
    expect(mocks.disposeForRepo).not.toHaveBeenCalled()
  })
})
