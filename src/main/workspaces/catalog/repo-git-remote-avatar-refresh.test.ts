import { afterEach, expect, it, vi } from 'vitest'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { deriveGitRemoteIdentity } from '../../../shared/git/remotes/git-remote-identity'
import '../../../shared/project/host-setup/project-host-setup-projection'
import { githubAvatarIcon } from '../../../shared/repository/appearance/repo-icon'
import type { Repo } from '../../../shared/repository/repo-types'
import type { RepoHostTarget } from '../../../shared/repository/repo-host-identity'
import '../../persistence/repo-host-target-matcher.test-fixture'
import { probeGitRemoteIdentity, type GitRemoteIdentityProbe } from './repo-git-remote-identity'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'

vi.mock('./repo-git-remote-identity', () => ({ probeGitRemoteIdentity: vi.fn() }))

function identity(remote = 'https://github.com/org-b/app.git') {
  const parsed = deriveGitRemoteIdentity(`origin\t${remote} (fetch)`)
  if (!parsed) {
    throw new Error('Fixture remote must parse')
  }
  return parsed
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'app',
    path: '/workspace/app',
    displayName: 'app',
    kind: 'git',
    badgeColor: '',
    addedAt: 1,
    upstream: null,
    gitRemoteIdentity: identity(),
    repoIcon: githubAvatarIcon({ owner: 'owner-a', repo: 'app' }),
    ...overrides
  }
}

function storeFor(repos: Repo[]) {
  const getRepo = (id: string, hostId?: ExecutionHostId) =>
    repos.find((row) => row.id === id && (!hostId || getRepoExecutionHostId(row) === hostId))
  const updateRepo = vi.fn((target: RepoHostTarget, updates: Partial<Repo>) => {
    const current = getRepo(target.id, getRepoExecutionHostId(target))
    if (!current) {
      return null
    }
    Object.assign(current, updates)
    return current
  })
  return { getRepos: () => repos, getRepo, updateRepo }
}

afterEach(() => {
  resetRepoGitRemoteIdentityEnrichmentForTests()
  vi.useRealTimers()
  vi.clearAllMocks()
})

// A runtime stamp addresses files here, but store writes must still use that stamp.

it('does not write after a pending local probe becomes peer-owned', async () => {
  let answer: ((value: GitRemoteIdentityProbe) => void) | undefined
  const row = repo({ gitRemoteIdentity: undefined })
  const originalIcon = row.repoIcon
  const store = storeFor([row])
  vi.mocked(probeGitRemoteIdentity).mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  enrichMissingRepoGitRemoteIdentities(store)
  row.executionHostId = 'runtime:peer'
  if (!answer) {
    throw new Error('Expected pending probe')
  }
  answer({ status: 'resolved', identity: identity() })
  await flushRepoGitRemoteIdentityEnrichmentForTests()
  expect(row.gitRemoteIdentity).toBeUndefined()
  expect(row.repoIcon).toBe(originalIcon)
  expect(store.updateRepo).not.toHaveBeenCalled()
})
