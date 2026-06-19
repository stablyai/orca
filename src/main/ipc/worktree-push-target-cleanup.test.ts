import { describe, expect, it, vi, type Mock } from 'vitest'
import type { GitPushTarget, WorktreeMeta } from '../../shared/types'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  sameGitHubRemoteUrl,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'

type ExecMock = Mock<GitRemoteExec>

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

type ExecScript = {
  branchConfig?: string
  getUrl?: string
  getUrlThrows?: boolean
}

function makeExec(script: ExecScript = {}): ExecMock {
  const { branchConfig = '', getUrl = FORK_URL, getUrlThrows = false } = script
  return vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'config') {
      return { stdout: branchConfig, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      if (getUrlThrows) {
        throw new Error('No such remote')
      }
      return { stdout: `${getUrl}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'remove') {
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

function removeCalls(exec: ExecMock): string[][] {
  return exec.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === 'remote' && args[1] === 'remove')
}

describe('cleanupUnusedWorktreePushTargetRemoteWithExec', () => {
  it('removes an Orca-created fork remote that nothing else uses', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([['remote', 'remove', FORK_REMOTE]])
  })

  it('keeps a remote Orca did not create (remoteCreated falsy)', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget({ remoteCreated: false }),
      storeOf({ 'repo-1::/wt/a': forkTarget({ remoteCreated: false }) }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
    // No probing at all when we won't act.
    expect(exec).not.toHaveBeenCalled()
  })

  it('never touches origin or upstream', async () => {
    for (const remoteName of ['origin', 'upstream']) {
      const exec = makeExec()
      await cleanupUnusedWorktreePushTargetRemoteWithExec(
        REPO_PATH,
        'repo-1::/wt/a',
        forkTarget({ remoteName }),
        storeOf({}),
        exec
      )
      expect(removeCalls(exec)).toEqual([])
    }
  })

  it('skips when the target has no remoteUrl', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget({ remoteUrl: undefined }),
      storeOf({}),
      exec
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('keeps the remote when another worktree in the same repo uses the same remote name (multi-fork)', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        'repo-1::/wt/b': forkTarget({ branchName: 'contributor/other' })
      }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('keeps the remote when another worktree points at the same fork via a differently-named remote', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
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
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('removes the remote even if a same-named remote exists in a DIFFERENT repo (remotes are repo-local)', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        'repo-2::/wt/c': forkTarget()
      }),
      exec
    )
    expect(removeCalls(exec)).toEqual([['remote', 'remove', FORK_REMOTE]])
  })

  it('keeps the remote when a branch config still tracks it', async () => {
    const exec = makeExec({
      branchConfig: `branch.contributor/fix.remote ${FORK_REMOTE}`
    })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('keeps the remote when its URL no longer matches the fork (repurposed by the user)', async () => {
    const exec = makeExec({ getUrl: 'git@github.com:someone-else/orca.git' })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('does nothing when the remote is already gone (get-url throws)', async () => {
    const exec = makeExec({ getUrlThrows: true })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
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

  it('falls back to exact equality for non-GitHub hosts', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@gitlab.com:contributor/orca.git',
        'git@gitlab.com:contributor/orca.git'
      )
    ).toBe(true)
    expect(
      sameGitHubRemoteUrl(
        'git@gitlab.com:contributor/orca.git',
        'https://gitlab.com/contributor/orca.git'
      )
    ).toBe(false)
  })
})
