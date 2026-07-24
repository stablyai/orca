import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'

// Fix for issue #7331: PR details failed to load on fork checkouts because
// getOwnerRepo() (the PR-lookup resolver) only consulted the `origin` remote
// (the fork), while the PRs live on the upstream parent. getOwnerRepo now
// prefers `upstream` when present, mirroring getIssueOwnerRepo.

const { gitExecFileAsyncMock, ghExecFileAsyncMock, readLocalGitConfigSignatureMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    ghExecFileAsyncMock: vi.fn(),
    readLocalGitConfigSignatureMock: vi.fn(async () => 'sig')
  })
)

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: () => null
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

import {
  getOwnerRepo,
  getIssueOwnerRepo,
  getOwnerRepoForRemote,
  _resetOwnerRepoCache
} from './github-repository-identity'
import { getRepoUpstream } from './client'

const FORK_PATH = '/tmp/fork-checkout'
const NON_FORK_PATH = '/tmp/plain-checkout'
const SSH_FORK_PATH = '/tmp/ssh-fork-checkout'

// origin -> personal fork, upstream -> parent (the classic fork checkout).
const REMOTE_URLS_BY_REPO: Record<string, Record<string, string>> = {
  [FORK_PATH]: {
    origin: 'https://github.com/fsdwen/orca.git',
    upstream: 'https://github.com/stablyai/orca.git'
  },
  [NON_FORK_PATH]: {
    origin: 'https://github.com/stablyai/orca.git'
  },
  [SSH_FORK_PATH]: {
    origin: 'git@github.com:fsdwen/orca.git',
    upstream: 'git@github.com:stablyai/orca.git'
  }
}

beforeEach(() => {
  _resetOwnerRepoCache()
  gitExecFileAsyncMock.mockReset()
  ghExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(
    async (args: string[], options: { cwd?: string } = {}) => {
      // getRemoteUrlForRepo calls: ['remote', 'get-url', <remoteName>]
      const remoteName = args[2]
      const url = REMOTE_URLS_BY_REPO[options.cwd ?? '']?.[remoteName]
      if (!url) {
        const err = new Error(`fatal: No such remote '${remoteName}'`) as Error & { code?: number }
        err.code = 128
        throw err
      }
      return { stdout: url }
    }
  )
})

describe('issue #7331: fork PR owner/repo resolution', () => {
  it('getOwnerRepo prefers the upstream parent on a fork checkout', async () => {
    const prRepo = await getOwnerRepo(FORK_PATH)

    // PRs live on the parent, so PR lookups must target it (matches
    // getIssueOwnerRepo).
    expect(prRepo).toEqual({ owner: 'stablyai', repo: 'orca' })
  })

  it('getOwnerRepo and getIssueOwnerRepo agree on a fork checkout', async () => {
    const prRepo = await getOwnerRepo(FORK_PATH)
    const issueRepo = await getIssueOwnerRepo(FORK_PATH)

    expect(prRepo).toEqual(issueRepo)
  })

  it('getOwnerRepo falls back to origin when there is no upstream remote', async () => {
    const prRepo = await getOwnerRepo(NON_FORK_PATH)

    expect(prRepo).toEqual({ owner: 'stablyai', repo: 'orca' })
  })

  it('caches the missing-upstream probe so repeat lookups skip the git spawn', async () => {
    await getOwnerRepo(NON_FORK_PATH)
    const upstreamProbes = (): number =>
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args[2] === 'upstream').length
    expect(upstreamProbes()).toBe(1)

    await getOwnerRepo(NON_FORK_PATH)
    // Second lookup within the negative-cache TTL must not respawn git for
    // the missing upstream remote.
    expect(upstreamProbes()).toBe(1)
  })

  it('resolves the upstream parent for SSH-style remote URLs', async () => {
    const prRepo = await getOwnerRepo(SSH_FORK_PATH)

    expect(prRepo).toEqual({ owner: 'stablyai', repo: 'orca' })
  })

  it('getOwnerRepoForRemote(origin) still resolves the fork itself', async () => {
    // Callers that combine origin+upstream themselves (getRepoUpstream,
    // resolvePrWorkItemSource) depend on an origin-only primitive.
    const origin = await getOwnerRepoForRemote(FORK_PATH, 'origin')

    expect(origin).toEqual({ owner: 'fsdwen', repo: 'orca' })
  })

  it('getRepoUpstream still resolves the fork parent offline (regression)', async () => {
    // If getRepoUpstream compared upstream against an upstream-first
    // getOwnerRepo, the remotes would look identical and the offline fork
    // fast-path would be skipped.
    const upstream = await getRepoUpstream(FORK_PATH)

    // Why: origin resolution pins github.com so host-scoped execution is explicit.
    expect(upstream).toEqual({ owner: 'stablyai', repo: 'orca', host: 'github.com' })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
