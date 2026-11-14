import { describe, expect, it, vi } from 'vitest'
import { assertRegisteredRepo } from './gitlab-repo-access'

const repoPath = '/workspace/repo'
const localRepo = {
  id: 'repo-1',
  path: repoPath,
  displayName: 'local',
  badgeColor: '#000',
  addedAt: 0
}
const sshRepo = { ...localRepo, displayName: 'ssh', connectionId: 'ssh-1' }

function makeStore() {
  return {
    getRepo: vi.fn(() => localRepo),
    getRepos: vi.fn(() => [localRepo, sshRepo])
  }
}

describe('GitLab repo owner selection', () => {
  it('selects the exact owner when ids and paths collide', () => {
    expect(
      assertRegisteredRepo(
        {
          repoPath,
          repoId: 'repo-1',
          repoOwnerExecutionHostId: 'ssh:ssh-1'
        },
        makeStore() as never
      )
    ).toBe(sshRepo)
  })

  it('fails closed when the explicit owner is absent', () => {
    expect(() =>
      assertRegisteredRepo(
        {
          repoPath,
          repoId: 'repo-1',
          repoOwnerExecutionHostId: 'runtime:missing'
        },
        makeStore() as never
      )
    ).toThrow('Access denied: unknown repository path')
  })
})
