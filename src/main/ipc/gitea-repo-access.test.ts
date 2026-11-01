import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { assertRegisteredGiteaRepo } from './gitea-repo-access'

const repoPath = '/workspace/repo'
const localRepo = {
  id: 'repo-1',
  path: repoPath,
  displayName: 'local',
  badgeColor: '#000',
  addedAt: 0
}
const sshRepo = { ...localRepo, displayName: 'ssh', connectionId: 'ssh-1' }

function makeStore(): Store {
  return {
    getRepo: vi.fn(() => localRepo),
    getRepos: vi.fn(() => [localRepo, sshRepo])
    // SAFETY: the access helper only reads getRepo and getRepos.
  } as unknown as Store
}

describe('Gitea repo owner selection', () => {
  it('selects the exact owner when ids and paths collide', () => {
    expect(
      assertRegisteredGiteaRepo(
        {
          repoPath,
          repoId: 'repo-1',
          repoOwnerExecutionHostId: 'ssh:ssh-1'
        },
        makeStore()
      )
    ).toBe(sshRepo)
  })

  it('fails closed when the explicit owner is absent', () => {
    expect(() =>
      assertRegisteredGiteaRepo(
        {
          repoPath,
          repoId: 'repo-1',
          repoOwnerExecutionHostId: 'runtime:missing'
        },
        makeStore()
      )
    ).toThrow('Access denied: unknown repository path')
  })
})
