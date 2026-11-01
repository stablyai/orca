import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleMock = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: vi.fn()
  }
}))

vi.mock('../../git/repo', () => ({
  getBaseRefDefault: vi.fn(),
  getRemoteCount: vi.fn(),
  searchBaseRefDetails: vi.fn()
}))

vi.mock('../../project-runtime-git-options', () => ({
  getProjectRuntimeReadGitOptions: () => ({})
}))

vi.mock('../../wsl/wsl-unc-access-gate', () => ({
  blockedWslDistroForPath: async () => null
}))

vi.mock('../preflight-wsl-refusal-retry', () => ({
  broadcastWhenWslDistroRunning: () => {}
}))

import { registerBaseRefQueryHandlers } from './base-ref-query-handlers'
import { searchBaseRefDetails } from '../../git/repo'

describe('repos:searchBaseRefs local catalog refresh', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const fetchRemoteWithCache = vi.fn().mockResolvedValue(undefined)
  const store = { getRepo: vi.fn(), getRepos: vi.fn() }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    store.getRepo.mockReset()
    fetchRemoteWithCache.mockReset().mockResolvedValue(undefined)
    vi.mocked(searchBaseRefDetails).mockReset().mockResolvedValue([
      { refName: 'upstream/release-1.4.156', localBranchName: 'release-1.4.156' }
    ] as never)
    registerBaseRefQueryHandlers(store as never, { fetchRemoteWithCache })
  })

  it('fetches the canonical remote before enumerating local refs', async () => {
    store.getRepo.mockReturnValue({
      id: 'r1',
      path: '/Users/me/fork',
      kind: 'git',
      gitRemoteIdentity: {
        remoteName: 'upstream',
        remoteUrl: 'https://github.com/stablyai/orca.git',
        canonicalKey: 'github.com/stablyai/orca'
      }
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'release'
    })

    expect(fetchRemoteWithCache).toHaveBeenCalledWith('/Users/me/fork', 'upstream')
    expect(result).toEqual(['upstream/release-1.4.156'])
  })

  it('falls back to origin when gitRemoteIdentity is unset', async () => {
    store.getRepo.mockReturnValue({
      id: 'r1',
      path: '/Users/me/repo',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    expect(fetchRemoteWithCache).toHaveBeenCalledWith('/Users/me/repo', 'origin')
  })

  it('still returns local refs when the discovery fetch fails', async () => {
    fetchRemoteWithCache.mockRejectedValueOnce(new Error('offline'))
    store.getRepo.mockReturnValue({
      id: 'r1',
      path: '/Users/me/repo',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'release'
    })

    expect(result).toEqual(['upstream/release-1.4.156'])
  })
})
