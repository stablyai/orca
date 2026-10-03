import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(name, handler),
    removeHandler: vi.fn()
  }
}))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))

import { registerRepoUpdateHandler } from './repo-update-handler'

describe('repos:update languageServers', () => {
  const updateRepo = vi.fn((_id: string, updates: unknown) => ({ id: 'r1', ...Object(updates) }))
  beforeEach(() => {
    mocks.handlers.clear()
    updateRepo.mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls updateRepo on this store in these cases.
    registerRepoUpdateHandler({} as never, { updateRepo } as never)
  })

  it('stores normalized settings', () => {
    mocks.handlers.get('repos:update')?.(
      {},
      { repoId: 'r1', updates: { languageServers: { enabled: { typescript: true, x: true } } } }
    )
    expect(updateRepo).toHaveBeenCalledWith('r1', {
      languageServers: { enabled: { typescript: true } }
    })
  })

  it('clears settings on null or garbage', () => {
    mocks.handlers.get('repos:update')?.({}, { repoId: 'r1', updates: { languageServers: null } })
    expect(updateRepo).toHaveBeenLastCalledWith('r1', { languageServers: undefined })
  })
})
