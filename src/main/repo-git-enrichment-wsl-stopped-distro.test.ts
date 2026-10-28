import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type * as WslUncAccessGateModule from './wsl/wsl-unc-access-gate'

const mocks = vi.hoisted(() => ({
  stopped: true,
  probeGitRemoteIdentity: vi.fn(),
  resolveLocalGitUsernameDetailed: vi.fn(),
  blockedWslDistroForPath: vi.fn(),
  wslDistroForPath: vi.fn()
}))
vi.mock('./repo-git-remote-identity', () => ({
  probeGitRemoteIdentity: mocks.probeGitRemoteIdentity
}))
vi.mock('./git/git-username', () => ({
  resolveLocalGitUsernameDetailed: mocks.resolveLocalGitUsernameDetailed
}))
vi.mock('./wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslUncAccessGateModule>()),
  blockedWslDistroForPath: mocks.blockedWslDistroForPath,
  wslDistroForPath: mocks.wslDistroForPath
}))

import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'
import {
  enrichRepoGitUsernames,
  flushRepoGitUsernameEnrichmentForTests,
  resetRepoGitUsernameEnrichmentForTests
} from './repo-git-username-enrichment'

const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

function makeRepo(path: string): Repo {
  return { id: 'repo-1', path, displayName: 'repo', badgeColor: '#000', addedAt: 1, kind: 'git' }
}

function makeStore(repo: Repo) {
  return {
    getRepos: () => [repo],
    getRepo: () => repo,
    updateRepo: vi.fn(() => repo),
    setResolvedRepoGitUsername: vi.fn(() => true)
  }
}

describe('repo Git enrichment for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stopped = true
    resetRepoGitRemoteIdentityEnrichmentForTests()
    resetRepoGitUsernameEnrichmentForTests()
    mocks.probeGitRemoteIdentity.mockResolvedValue({ status: 'no-remote' })
    mocks.resolveLocalGitUsernameDetailed.mockResolvedValue({ username: 'me', authoritative: true })
    mocks.wslDistroForPath.mockImplementation((path: string) =>
      path.startsWith('\\\\wsl.localhost\\') ? 'Ubuntu' : null
    )
    mocks.blockedWslDistroForPath.mockImplementation(async () =>
      mocks.stopped ? { distro: 'Ubuntu', state: 'stopped' } : null
    )
  })

  it('probes no remote identity while stopped, and retries on the next sweep once it runs', async () => {
    const store = makeStore(makeRepo(WSL_REPO))
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    expect(mocks.probeGitRemoteIdentity).not.toHaveBeenCalled()

    mocks.stopped = false
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    expect(mocks.probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
  })

  it('reads no Git username while stopped, and reads it on a later pass once it runs', async () => {
    const store = makeStore(makeRepo(WSL_REPO))
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()
    expect(mocks.resolveLocalGitUsernameDetailed).not.toHaveBeenCalled()

    mocks.stopped = false
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()
    expect(mocks.resolveLocalGitUsernameDetailed).toHaveBeenCalledTimes(1)
  })

  it('enriches a host repo exactly as before, without asking the gate', async () => {
    const store = makeStore(makeRepo('C:/repos/one'))
    enrichMissingRepoGitRemoteIdentities(store)
    enrichRepoGitUsernames(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    await flushRepoGitUsernameEnrichmentForTests()
    expect(mocks.probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(mocks.resolveLocalGitUsernameDetailed).toHaveBeenCalledTimes(1)
    expect(mocks.blockedWslDistroForPath).not.toHaveBeenCalled()
  })
})
