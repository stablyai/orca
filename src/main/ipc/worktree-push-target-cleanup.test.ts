import { describe, expect, it, vi } from 'vitest'
import { sameGitHubRemoteUrl } from '../../shared/git-push-target-remote-url'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  cleanupUnusedWorktreePushTargetRemoteWithGit,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'

const REPO_PATH = '/repo-root'
const FORK_URL = 'git@github.com:contributor/orca.git'
const FORK_REMOTE = 'pr-contributor-orca'

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: FORK_REMOTE,
    branchName: 'contributor/fix',
    remoteUrl: FORK_URL,
    remoteCreated: true,
    ...overrides
  }
}

// Why: cleanup only reads meta.pushTarget, so the rest of WorktreeMeta is irrelevant.
function metaWith(pushTarget: GitPushTarget | undefined): WorktreeMeta {
  return { pushTarget } as unknown as WorktreeMeta
}

function storeOf(entries: Record<string, GitPushTarget | undefined>): WorktreePushTargetStore {
  const meta: Record<string, WorktreeMeta> = {}
  for (const [id, pushTarget] of Object.entries(entries)) {
    meta[id] = metaWith(pushTarget)
  }
  return { getAllWorktreeMeta: () => meta }
}

type GitState = {
  branchConfig?: string
  getUrl?: string
  getUrlThrows?: boolean
}

function makeGit(state: GitState = {}) {
  const { branchConfig = '', getUrl = FORK_URL, getUrlThrows = false } = state
  const getRemoteUrl = vi.fn(async () => {
    if (getUrlThrows) {
      throw new Error('No such remote')
    }
    return getUrl
  })
  const removedRemote = vi.fn(async (_repoPath: string, _target: GitPushTarget) => {})
  return {
    validateTarget: vi.fn(async () => {}),
    listRemotes: vi.fn(async () => []),
    getRemoteUrl,
    addRemote: vi.fn(async () => {}),
    fetchRemoteTrackingRef: vi.fn(async () => {}),
    configureUpstream: vi.fn(async () => {}),
    readBranchRemoteConfig: vi.fn(async () => branchConfig),
    removeRemoteIfMatches: vi.fn(async (repoPath: string, target: GitPushTarget) => {
      try {
        if (sameGitHubRemoteUrl(await getRemoteUrl(), target.remoteUrl!)) {
          await removedRemote(repoPath, target)
        }
      } catch {
        // Mirrors the best-effort adapter boundary.
      }
    }),
    removedRemote
  }
}

describe('cleanupUnusedWorktreePushTargetRemoteWithGit', () => {
  it('removes an Orca-created fork remote that nothing else uses', async () => {
    const git = makeGit()
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      git
    )
    expect(git.removedRemote).toHaveBeenCalledWith(REPO_PATH, forkTarget())
    expect(git.getRemoteUrl).toHaveBeenCalledOnce()
  })

  it('keeps a remote Orca did not create (remoteCreated falsy)', async () => {
    const git = makeGit()
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget({ remoteCreated: false }),
      storeOf({ 'repo-1::/wt/a': forkTarget({ remoteCreated: false }) }),
      git
    )
    expect(git.removedRemote).not.toHaveBeenCalled()
    // No probing at all when we won't act.
    expect(git.getRemoteUrl).not.toHaveBeenCalled()
  })

  it('never touches origin or upstream', async () => {
    for (const remoteName of ['origin', 'upstream']) {
      const git = makeGit()
      await cleanupUnusedWorktreePushTargetRemoteWithGit(
        REPO_PATH,
        'repo-1::/wt/a',
        forkTarget({ remoteName }),
        storeOf({}),
        git
      )
      expect(git.removedRemote).not.toHaveBeenCalled()
    }
  })

  it('skips when the target has no remoteUrl', async () => {
    const git = makeGit()
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget({ remoteUrl: undefined }),
      storeOf({}),
      git
    )
    expect(git.getRemoteUrl).not.toHaveBeenCalled()
  })

  it('keeps the remote when another worktree in the same repo uses the same remote name (multi-fork)', async () => {
    const git = makeGit()
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        'repo-1::/wt/b': forkTarget({ branchName: 'contributor/other' })
      }),
      git
    )
    expect(git.removedRemote).not.toHaveBeenCalled()
  })

  it('keeps the remote when another worktree points at the same fork via a differently-named remote', async () => {
    const git = makeGit()
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        // Same fork URL (https form), different sanitized remote name.
        'repo-1::/wt/b': forkTarget({
          remoteName: 'fork-2',
          remoteUrl: 'https://github.com/contributor/orca.git'
        })
      }),
      git
    )
    expect(git.removedRemote).not.toHaveBeenCalled()
  })

  it('removes the remote even if a same-named remote exists in a DIFFERENT repo (remotes are repo-local)', async () => {
    const git = makeGit()
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        'repo-2::/wt/c': forkTarget()
      }),
      git
    )
    expect(git.removedRemote).toHaveBeenCalledWith(REPO_PATH, forkTarget())
  })

  it('keeps the remote when a branch config still tracks it', async () => {
    const git = makeGit({
      branchConfig: `branch.contributor/fix.remote ${FORK_REMOTE}`
    })
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      git
    )
    expect(git.removedRemote).not.toHaveBeenCalled()
  })

  it('checks branch config without line-array or whitespace-regex splitting', async () => {
    const git = makeGit({
      branchConfig: [
        `branch.contributor/fix.pushRemote\tunused`,
        `  branch.contributor/fix.remote    ${FORK_REMOTE}  `
      ].join('\r\n')
    })
    const splitSpy = vi.spyOn(String.prototype, 'split')
    try {
      await cleanupUnusedWorktreePushTargetRemoteWithGit(
        REPO_PATH,
        'repo-1::/wt/a',
        forkTarget(),
        storeOf({ 'repo-1::/wt/a': forkTarget() }),
        git
      )
      const usedUnboundedOutputSplit = splitSpy.mock.calls.some(([separator]) => {
        return (
          separator instanceof RegExp &&
          (separator.source === '\\r?\\n' || separator.source === '\\s+')
        )
      })
      expect(git.removedRemote).not.toHaveBeenCalled()
      expect(usedUnboundedOutputSplit).toBe(false)
    } finally {
      splitSpy.mockRestore()
    }
  })

  it('keeps the remote when its URL no longer matches the fork (repurposed by the user)', async () => {
    const git = makeGit({ getUrl: 'git@github.com:someone-else/orca.git' })
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      git
    )
    expect(git.removedRemote).not.toHaveBeenCalled()
  })

  it('does nothing when the remote is already gone (get-url throws)', async () => {
    const git = makeGit({ getUrlThrows: true })
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      git
    )
    expect(git.removedRemote).not.toHaveBeenCalled()
  })
})

describe('sameGitHubRemoteUrl', () => {
  it('matches SSH and HTTPS forms of the same GitHub fork', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@github.com:contributor/orca.git',
        'https://github.com/contributor/orca.git'
      )
    ).toBe(true)
  })

  it('matches www and ssh.github.com aliases of the same fork', () => {
    expect(
      sameGitHubRemoteUrl(
        'https://www.github.com/contributor/orca.git',
        'git@ssh.github.com:contributor/orca.git'
      )
    ).toBe(true)
  })

  it('matches an existing GitHub remote without a .git suffix', () => {
    expect(
      sameGitHubRemoteUrl(
        'https://github.com/contributor/orca',
        'git@github.com:contributor/orca.git'
      )
    ).toBe(true)
  })

  it('is case-insensitive on owner/repo', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@github.com:Contributor/Orca.git',
        'git@github.com:contributor/orca.git'
      )
    ).toBe(true)
  })

  it('does not match different forks', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@github.com:contributor/orca.git',
        'git@github.com:someone-else/orca.git'
      )
    ).toBe(false)
  })

  it('rejects non-GitHub hosts even when the raw URLs are identical', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@gitlab.com:contributor/orca.git',
        'git@gitlab.com:contributor/orca.git'
      )
    ).toBe(false)
    expect(sameGitHubRemoteUrl('../sibling-repo', '../sibling-repo')).toBe(false)
  })

  it('does not ignore non-default HTTPS ports', () => {
    expect(
      sameGitHubRemoteUrl(
        'https://github.com:8443/contributor/orca.git',
        'https://github.com/contributor/orca.git'
      )
    ).toBe(false)
  })

  it('does not ignore non-default SSH ports', () => {
    expect(
      sameGitHubRemoteUrl(
        'ssh://git@github.com:2222/contributor/orca.git',
        'git@github.com:contributor/orca.git'
      )
    ).toBe(false)
    expect(
      sameGitHubRemoteUrl(
        'ssh://git@github.com:2222/contributor/orca.git',
        'ssh://git@github.com/contributor/orca.git'
      )
    ).toBe(false)
  })

  it('keeps default and documented SSH endpoints equivalent', () => {
    expect(
      sameGitHubRemoteUrl(
        'ssh://git@github.com:22/contributor/orca.git',
        'git@github.com:contributor/orca.git'
      )
    ).toBe(true)
    expect(
      sameGitHubRemoteUrl(
        'ssh://git@ssh.github.com:443/contributor/orca.git',
        'git@github.com:contributor/orca.git'
      )
    ).toBe(true)
  })
})
