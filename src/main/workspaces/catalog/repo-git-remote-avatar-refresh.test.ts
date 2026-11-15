import { afterEach, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { deriveGitRemoteIdentity } from '../../../shared/git/remotes/git-remote-identity'
import '../../../shared/project-host-setup-projection'
import { githubAvatarIcon, type RepoIcon } from '../../../shared/repo-icon'
import type { Repo } from '../../../shared/repo-types'
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import { repoTarget } from '../../persistence/repo-host-target-matcher.test-fixture'
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

async function sweep(store: ReturnType<typeof storeFor>, onChanged = vi.fn()) {
  enrichMissingRepoGitRemoteIdentities(store, { onChanged })
  for (let i = 0; i < 8; i++) {
    await flushRepoGitRemoteIdentityEnrichmentForTests()
  }
}

async function refresh(store: ReturnType<typeof storeFor>, onChanged = vi.fn()) {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  await sweep(store, onChanged)
  expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  vi.setSystemTime(301_001)
  await sweep(store, onChanged)
}

afterEach(() => {
  resetRepoGitRemoteIdentityEnrichmentForTests()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('keeps local metadata writes scoped when a same-id ssh:build row comes first', async () => {
  const foreignIdentity = identity('https://github.com/foreign/app.git')
  const foreignIcon = githubAvatarIcon({ owner: 'foreign', repo: 'app' })
  const foreign = repo({
    executionHostId: 'ssh:build',
    gitRemoteIdentity: foreignIdentity,
    repoIcon: foreignIcon
  })
  const local = repo({ gitRemoteIdentity: identity('https://github.com/old-local/app.git') })
  const store = storeFor([foreign, local])
  vi.mocked(probeGitRemoteIdentity).mockImplementation(async (_path, probeHostId) => ({
    status: 'resolved',
    identity: probeHostId === 'local' ? identity() : foreignIdentity
  }))
  await refresh(store)
  expect(foreign.gitRemoteIdentity).toBe(foreignIdentity)
  expect(foreign.repoIcon).toBe(foreignIcon)
  expect(local.gitRemoteIdentity).toEqual(identity())
  expect(local.repoIcon).toEqual(githubAvatarIcon({ owner: 'org-b', repo: 'app' }))
  expect(store.updateRepo).toHaveBeenCalledExactlyOnceWith(repoTarget('app', 'local'), {
    gitRemoteIdentity: identity(),
    repoIcon: local.repoIcon
  })
})

// A runtime stamp addresses files here, but store writes must still use that stamp.
it('repairs a same-id runtime-addressed row under its own stamp', async () => {
  const runtimeRow = repo({
    executionHostId: 'runtime:env-a',
    gitRemoteIdentity: identity('https://github.com/old-runtime/app.git'),
    repoIcon: githubAvatarIcon({ owner: 'old-runtime', repo: 'app' })
  })
  const local = repo({ gitRemoteIdentity: identity('https://github.com/old-local/app.git') })
  const store = storeFor([runtimeRow, local])
  vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'resolved', identity: identity() })
  await refresh(store)
  expect(probeGitRemoteIdentity).toHaveBeenCalledWith(
    '/workspace/app',
    'local',
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  const repaired = {
    gitRemoteIdentity: identity(),
    repoIcon: githubAvatarIcon({ owner: 'org-b', repo: 'app' })
  }
  expect(runtimeRow).toMatchObject(repaired)
  expect(local).toMatchObject(repaired)
  expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('app', 'runtime:env-a'), repaired)
  expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('app', 'local'), repaired)
})

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

it('does not overwrite a custom icon selected while the probe is pending', async () => {
  let answer: ((value: GitRemoteIdentityProbe) => void) | undefined
  const row = repo({ gitRemoteIdentity: undefined })
  const store = storeFor([row])
  vi.mocked(probeGitRemoteIdentity).mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  enrichMissingRepoGitRemoteIdentities(store)
  const selected: RepoIcon = { type: 'emoji', emoji: '🐙' }
  row.repoIcon = selected
  if (!answer) {
    throw new Error('Expected pending probe')
  }
  answer({ status: 'resolved', identity: identity() })
  await flushRepoGitRemoteIdentityEnrichmentForTests()
  expect(row.repoIcon).toBe(selected)
  expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('app', 'local'), {
    gitRemoteIdentity: identity()
  })
})
