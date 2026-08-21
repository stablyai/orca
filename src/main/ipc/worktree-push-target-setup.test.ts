import { describe, expect, it, vi, type Mock } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec } from './worktree-push-target-cleanup'
import {
  configureCreatedWorktreePushTargetWithExec,
  ensureUniqueRemoteName,
  findRemoteForUrl,
  prepareWorktreePushTargetWithExec
} from './worktree-push-target-setup'

type ExecMock = Mock<GitRemoteExec>

const REPO = '/repo-root'
const FORK_SSH = 'git@github.com:contributor/mcode.git'
const FORK_HTTPS = 'https://github.com/contributor/mcode.git'

// A stateful fake git: `remotes` maps name -> url. `remote add` mutates it so
// later lookups see the new remote, matching real git behavior.
function makeRepoExec(remotes: Record<string, string>): ExecMock {
  return vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: Object.keys(remotes).join('\n'), stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2]!]
      if (!url) {
        throw new Error(`No such remote ${args[2]}`)
      }
      return { stdout: `${url}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'add') {
      remotes[args[2]!] = args[3]!
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

function callsMatching(exec: ExecMock, head: string[]): string[][] {
  return exec.mock.calls
    .map(([args]) => args)
    .filter((args) => head.every((part, i) => args[i] === part))
}

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: 'pr-contributor-mcode',
    branchName: 'contributor/fix',
    remoteUrl: FORK_SSH,
    ...overrides
  }
}

describe('prepareWorktreePushTargetWithExec', () => {
  it('adds a new fork remote and fetches its head when none matches', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:mcode-ide/mcode.git' })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([
      ['remote', 'add', 'pr-contributor-mcode', FORK_SSH]
    ])
    expect(callsMatching(exec, ['fetch'])).toEqual([
      [
        'fetch',
        'pr-contributor-mcode',
        '+refs/heads/contributor/fix:refs/remotes/pr-contributor-mcode/contributor/fix'
      ]
    ])
    expect(result).toEqual({
      remoteName: 'pr-contributor-mcode',
      branchName: 'contributor/fix',
      remoteUrl: FORK_SSH,
      remoteCreated: true
    })
  })

  it('reuses an existing remote pointing at the same fork (SSH vs HTTPS) without adding', async () => {
    const exec = makeRepoExec({
      origin: 'git@github.com:mcode-ide/mcode.git',
      'pr-contributor-mcode': FORK_HTTPS
    })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([])
    expect(callsMatching(exec, ['fetch'])).toEqual([
      [
        'fetch',
        'pr-contributor-mcode',
        '+refs/heads/contributor/fix:refs/remotes/pr-contributor-mcode/contributor/fix'
      ]
    ])
    // remoteCreated omitted because the predicate says no known worktree owns it.
    expect(result).toEqual({
      remoteName: 'pr-contributor-mcode',
      branchName: 'contributor/fix',
      remoteUrl: FORK_SSH
    })
  })

  it('inherits remoteCreated when the predicate says a known worktree created the reused remote', async () => {
    const exec = makeRepoExec({ 'fork-x': FORK_HTTPS })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => true)

    expect(result.remoteName).toBe('fork-x')
    expect(result.remoteCreated).toBe(true)
  })

  it('disambiguates with a numeric suffix when the preferred remote name is taken by a different URL', async () => {
    const exec = makeRepoExec({ 'pr-contributor-mcode': 'git@github.com:someone-else/mcode.git' })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([
      ['remote', 'add', 'pr-contributor-mcode-2', FORK_SSH]
    ])
    expect(result.remoteName).toBe('pr-contributor-mcode-2')
    expect(result.remoteCreated).toBe(true)
  })

  it('strips an incoming remoteCreated flag and fetches the given remote when there is no remoteUrl', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:mcode-ide/mcode.git' })

    const result = await prepareWorktreePushTargetWithExec(
      exec,
      REPO,
      { remoteName: 'origin', branchName: 'feature', remoteCreated: true },
      () => false
    )

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([])
    expect(callsMatching(exec, ['fetch'])).toEqual([
      ['fetch', 'origin', '+refs/heads/feature:refs/remotes/origin/feature']
    ])
    expect(result).toEqual({ remoteName: 'origin', branchName: 'feature' })
  })
})

describe('findRemoteForUrl', () => {
  it('matches by GitHub owner/repo across URL protocols', async () => {
    const exec = makeRepoExec({
      origin: 'git@github.com:mcode-ide/mcode.git',
      fork: FORK_SSH
    })
    await expect(findRemoteForUrl(exec, REPO, FORK_HTTPS)).resolves.toBe('fork')
  })

  it('returns null when no remote points at the fork', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:mcode-ide/mcode.git' })
    await expect(findRemoteForUrl(exec, REPO, FORK_SSH)).resolves.toBeNull()
  })
})

describe('ensureUniqueRemoteName', () => {
  it('returns the preferred name when it is free', async () => {
    const exec = makeRepoExec({ origin: 'x' })
    await expect(ensureUniqueRemoteName(exec, REPO, 'fork')).resolves.toBe('fork')
  })

  it('suffixes past taken names', async () => {
    const exec = makeRepoExec({ fork: 'x', 'fork-2': 'y' })
    await expect(ensureUniqueRemoteName(exec, REPO, 'fork')).resolves.toBe('fork-3')
  })
})

describe('configureCreatedWorktreePushTargetWithExec', () => {
  it('points the new branch upstream at the fork remote', async () => {
    const exec = makeRepoExec({})
    const target = forkTarget()

    const result = await configureCreatedWorktreePushTargetWithExec(
      exec,
      '/wt/path',
      'local-branch',
      target
    )

    expect(exec).toHaveBeenCalledWith(
      ['branch', '--set-upstream-to', 'pr-contributor-mcode/contributor/fix', 'local-branch'],
      '/wt/path'
    )
    expect(result).toBe(target)
  })
})
