import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../../../shared/testing/remove-temp-dirs.test-support'
import {
  createLinkedWorktreeFixture,
  fixtureGit,
  FORK_URL,
  ORIGIN_URL,
  restoreGitConfigEnv,
  type LinkedWorktreeFixture
} from './tracked-upstream-worktrees.test-support'

const identity = vi.hoisted(() => {
  const byUrl: Record<string, { owner: string; repo: string; host: string }> = {
    'https://example.invalid/acme/app.git': { owner: 'acme', repo: 'app', host: 'github.com' },
    'https://example.invalid/fork/app.git': { owner: 'fork', repo: 'app', host: 'github.com' },
    'https://example.invalid/personal/app.git': {
      owner: 'personal',
      repo: 'app',
      host: 'github.com'
    }
  }
  const byRemote: Record<string, string> = {
    origin: 'https://example.invalid/acme/app.git',
    fork: 'https://example.invalid/fork/app.git'
  }
  return {
    forUrl: vi.fn(async (_repoPath: string, url: string) => byUrl[url] ?? null),
    forRemote: vi.fn(async (_repoPath: string, remote: string) => byUrl[byRemote[remote]] ?? null)
  }
})

// Owner/repo identity has its own caches; manual refresh must not reach them through this path.
vi.mock('../../repositories/github-api-repository-remote-probe', () => ({
  getGitHubApiRepositoryForRemoteUrl: identity.forUrl,
  getGitHubApiRepositoryForRemote: identity.forRemote
}))
const prLookup = vi.hoisted(() => ({
  byBranch: vi.fn(async (_request: { headRepo: { owner: string } | null }) => ({
    data: null,
    dataRepo: null
  }))
}))
vi.mock('../../repositories/github-api-repository', () => ({
  resolveGitHubApiRepositoryCandidates: async () => {
    const origin = { owner: 'acme', repo: 'app', host: 'github.com' }
    return { candidates: [origin], headRepo: origin }
  }
}))
vi.mock('./pr-branch-lookup', () => ({ lookupPRByBranchName: prLookup.byBranch }))

import { resolvePRForBranchOutcome } from './branch-lookup-resolution'
import { getConfiguredPushHead, getTrackedUpstreamHead } from './branch-review-heads'
import {
  trackedUpstreamSnapshotCache,
  trackedUpstreamSnapshotGenerations,
  trackedUpstreamSnapshotInFlight
} from './tracked-upstream-cache'

const roots: string[] = []
const savedEnv = {
  global: process.env.GIT_CONFIG_GLOBAL,
  nosystem: process.env.GIT_CONFIG_NOSYSTEM
}
const acme = { owner: 'acme', repo: 'app', host: 'github.com' }
const fork = { owner: 'fork', repo: 'app', host: 'github.com' }
let fixture: LinkedWorktreeFixture

beforeEach(async () => {
  trackedUpstreamSnapshotCache.clear()
  trackedUpstreamSnapshotInFlight.clear()
  trackedUpstreamSnapshotGenerations.clear()
  identity.forUrl.mockClear()
  identity.forRemote.mockClear()
  prLookup.byBranch.mockClear()
  fixture = await createLinkedWorktreeFixture(roots)
})

afterEach(async () => {
  restoreGitConfigEnv(savedEnv)
  await removeTempDirs(roots.splice(0))
})

describe('GitHub branch review heads in linked worktrees', () => {
  it('resolves each worktree’s configured push head in either order and concurrently', async () => {
    const { repoPath, worktreePath } = fixture
    const linkedHead = {
      branch: { remoteName: 'fork', branchName: 'feature' },
      headRepo: fork,
      configuredPush: true
    }
    const mainHead = {
      branch: { remoteName: 'origin', branchName: 'feature' },
      headRepo: acme,
      configuredPush: true
    }
    await expect(getConfiguredPushHead(worktreePath, 'feature', null, {})).resolves.toEqual(
      linkedHead
    )
    await expect(getConfiguredPushHead(repoPath, 'feature', null, {})).resolves.toEqual(mainHead)
    trackedUpstreamSnapshotCache.clear()
    await expect(
      Promise.all([
        getConfiguredPushHead(repoPath, 'feature', null, {}),
        getConfiguredPushHead(worktreePath, 'feature', null, {})
      ])
    ).resolves.toEqual([mainHead, linkedHead])
    expect(identity.forUrl).toHaveBeenCalledWith(worktreePath, FORK_URL, null, {})
    expect(identity.forUrl).toHaveBeenCalledWith(repoPath, ORIGIN_URL, null, {})
  })

  it('resolves each worktree’s tracked upstream head', async () => {
    const { repoPath, worktreePath } = fixture
    await expect(getTrackedUpstreamHead(repoPath, 'feature', null, {}, acme)).resolves.toBeNull()
    await expect(getTrackedUpstreamHead(worktreePath, 'feature', null, {}, acme)).resolves.toEqual({
      branch: { remoteName: 'fork', branchName: 'feature' },
      headRepo: fork
    })
  })

  it('re-reads branch config on manual refresh without bypassing owner/repo identity', async () => {
    const { worktreePath, globalConfigPath } = fixture
    const personalUrl = 'https://example.invalid/personal/app.git'
    fixtureGit(worktreePath, 'remote', 'add', 'personal', personalUrl)
    const lookup = (userRefresh: boolean) =>
      resolvePRForBranchOutcome({
        repoPath: worktreePath,
        branchName: 'feature',
        options: { userRefresh },
        localGitOptions: {},
        ghOptions: {},
        executionScope: 'fixture'
      })
    await expect(lookup(false)).resolves.toMatchObject({ kind: 'no-pr' })
    await writeFile(globalConfigPath, '[branch "feature"]\n\tpushRemote = personal\n')
    prLookup.byBranch.mockClear()
    await expect(lookup(false)).resolves.toMatchObject({ kind: 'no-pr' })
    expect(prLookup.byBranch.mock.calls.map(([request]) => request.headRepo?.owner)).toEqual([
      'acme',
      'fork'
    ])
    prLookup.byBranch.mockClear()
    identity.forUrl.mockClear()
    identity.forRemote.mockClear()

    await expect(lookup(true)).resolves.toMatchObject({ kind: 'no-pr' })
    expect(prLookup.byBranch.mock.calls.map(([request]) => request.headRepo?.owner)).toEqual([
      'acme',
      'fork',
      'personal'
    ])
    // Same arguments as a non-refresh call: no force reaches the identity probes.
    expect(identity.forRemote.mock.calls).toEqual([[worktreePath, 'fork', undefined, {}]])
    expect(identity.forUrl.mock.calls).toEqual([[worktreePath, personalUrl, undefined, {}]])
  })
})
