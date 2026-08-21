import { describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  configureCreatedWorktreePushTargetWithGit,
  ensureUniqueRemoteName,
  findRemoteForUrl,
  prepareWorktreePushTargetWithGit
} from './worktree-push-target-setup'

const REPO = '/repo-root'
const FORK_SSH = 'git@github.com:contributor/orca.git'
const FORK_HTTPS = 'https://github.com/contributor/orca.git'

function makeRepoGit(remotes: Record<string, string>) {
  return {
    validateTarget: vi.fn(async () => {}),
    listRemotes: vi.fn(async () => Object.keys(remotes)),
    getRemoteUrl: vi.fn(async (_repoPath: string, remoteName: string) => {
      const url = remotes[remoteName]
      if (!url) {
        throw new Error(`No such remote ${remoteName}`)
      }
      return url
    }),
    addRemote: vi.fn(async (_repoPath: string, target: GitPushTarget & { remoteUrl: string }) => {
      remotes[target.remoteName] = target.remoteUrl
    }),
    fetchRemoteTrackingRef: vi.fn(async () => {}),
    configureUpstream: vi.fn(async () => {}),
    readBranchRemoteConfig: vi.fn(async () => ''),
    removeRemoteIfMatches: vi.fn(async () => {})
  }
}

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: 'pr-contributor-orca',
    branchName: 'contributor/fix',
    remoteUrl: FORK_SSH,
    ...overrides
  }
}

describe('prepareWorktreePushTargetWithGit', () => {
  it('adds a new fork remote and fetches its head when none matches', async () => {
    const git = makeRepoGit({ origin: 'git@github.com:stablyai/orca.git' })
    const onRemoteAdded = vi.fn()

    const result = await prepareWorktreePushTargetWithGit(
      git,
      REPO,
      forkTarget(),
      () => false,
      onRemoteAdded
    )

    expect(git.addRemote).toHaveBeenCalledWith(REPO, forkTarget())
    expect(onRemoteAdded).toHaveBeenCalledWith(forkTarget())
    expect(git.fetchRemoteTrackingRef).toHaveBeenCalledWith(REPO, forkTarget())
    expect(result).toEqual({
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/fix',
      remoteUrl: FORK_SSH,
      remoteCreated: true
    })
  })

  it('reuses an existing remote pointing at the same fork (SSH vs HTTPS) without adding', async () => {
    const git = makeRepoGit({
      origin: 'git@github.com:stablyai/orca.git',
      'pr-contributor-orca': FORK_HTTPS
    })

    const result = await prepareWorktreePushTargetWithGit(git, REPO, forkTarget(), () => false)

    expect(git.addRemote).not.toHaveBeenCalled()
    expect(git.fetchRemoteTrackingRef).toHaveBeenCalledWith(REPO, forkTarget())
    // remoteCreated omitted because the predicate says no known worktree owns it.
    expect(result).toEqual({
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/fix',
      remoteUrl: FORK_SSH
    })
  })

  it('inherits remoteCreated when the predicate says a known worktree created the reused remote', async () => {
    const git = makeRepoGit({ 'fork-x': FORK_HTTPS })

    const result = await prepareWorktreePushTargetWithGit(git, REPO, forkTarget(), () => true)

    expect(result.remoteName).toBe('fork-x')
    expect(result.remoteCreated).toBe(true)
  })

  it('disambiguates with a numeric suffix when the preferred remote name is taken by a different URL', async () => {
    const git = makeRepoGit({ 'pr-contributor-orca': 'git@github.com:someone-else/orca.git' })

    const result = await prepareWorktreePushTargetWithGit(git, REPO, forkTarget(), () => false)

    expect(git.addRemote).toHaveBeenCalledWith(REPO, {
      ...forkTarget(),
      remoteName: 'pr-contributor-orca-2'
    })
    expect(result.remoteName).toBe('pr-contributor-orca-2')
    expect(result.remoteCreated).toBe(true)
  })

  it('removes a newly added remote when fetching its tracking ref fails', async () => {
    const git = makeRepoGit({ origin: 'git@github.com:stablyai/orca.git' })
    git.fetchRemoteTrackingRef.mockRejectedValueOnce(new Error('fetch failed'))

    await expect(
      prepareWorktreePushTargetWithGit(git, REPO, forkTarget(), () => false)
    ).rejects.toThrow('fetch failed')
    expect(git.removeRemoteIfMatches).toHaveBeenCalledWith(REPO, forkTarget())
  })

  it('keeps a reused Orca-owned remote when fetching its tracking ref fails', async () => {
    const git = makeRepoGit({ 'pr-contributor-orca': FORK_HTTPS })
    git.fetchRemoteTrackingRef.mockRejectedValueOnce(new Error('fetch failed'))

    await expect(
      prepareWorktreePushTargetWithGit(git, REPO, forkTarget(), () => true)
    ).rejects.toThrow('fetch failed')
    expect(git.removeRemoteIfMatches).not.toHaveBeenCalled()
  })

  it('strips an incoming remoteCreated flag and fetches the given remote when there is no remoteUrl', async () => {
    const git = makeRepoGit({ origin: 'git@github.com:stablyai/orca.git' })

    const result = await prepareWorktreePushTargetWithGit(
      git,
      REPO,
      { remoteName: 'origin', branchName: 'feature', remoteCreated: true },
      () => false
    )

    expect(git.addRemote).not.toHaveBeenCalled()
    expect(git.fetchRemoteTrackingRef).toHaveBeenCalledWith(REPO, {
      remoteName: 'origin',
      branchName: 'feature'
    })
    expect(result).toEqual({ remoteName: 'origin', branchName: 'feature' })
  })
})

describe('findRemoteForUrl', () => {
  it('matches by GitHub owner/repo across URL protocols', async () => {
    const git = makeRepoGit({
      origin: 'git@github.com:stablyai/orca.git',
      fork: FORK_SSH
    })
    await expect(findRemoteForUrl(git, REPO, FORK_HTTPS)).resolves.toBe('fork')
  })

  it('returns null when no remote points at the fork', async () => {
    const git = makeRepoGit({ origin: 'git@github.com:stablyai/orca.git' })
    await expect(findRemoteForUrl(git, REPO, FORK_SSH)).resolves.toBeNull()
  })
})

describe('ensureUniqueRemoteName', () => {
  it('returns the preferred name when it is free', async () => {
    const git = makeRepoGit({ origin: 'x' })
    await expect(ensureUniqueRemoteName(git, REPO, 'fork')).resolves.toBe('fork')
  })

  it('suffixes past taken names', async () => {
    const git = makeRepoGit({ fork: 'x', 'fork-2': 'y' })
    await expect(ensureUniqueRemoteName(git, REPO, 'fork')).resolves.toBe('fork-3')
  })

  it('keeps a colliding maximum-length remote name within the validated limit', async () => {
    const preferred = `fork-${'x'.repeat(95)}`
    const git = makeRepoGit({ [preferred]: 'x' })

    const result = await ensureUniqueRemoteName(git, REPO, preferred)

    expect(result).toHaveLength(100)
    expect(result).toBe(`${preferred.slice(0, 98)}-2`)
  })
})

describe('configureCreatedWorktreePushTargetWithGit', () => {
  it('points the new branch upstream at the fork remote', async () => {
    const git = makeRepoGit({})
    const target = forkTarget()

    const result = await configureCreatedWorktreePushTargetWithGit(
      git,
      '/wt/path',
      'local-branch',
      target
    )

    expect(git.configureUpstream).toHaveBeenCalledWith('/wt/path', 'local-branch', target)
    expect(result).toBe(target)
  })
})
