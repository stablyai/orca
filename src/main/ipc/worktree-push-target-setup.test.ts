import { describe, expect, it, vi, type Mock } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec } from './worktree-push-target-cleanup'
import {
  configureCreatedWorktreePushTargetWithExec,
  ensureUniqueRemoteName,
  findRemoteForUrl,
  prepareWorktreePushTargetWithExec,
  remoteAlreadyMatchesUrl,
  restoreUpstreamAfterMaterialize
} from './worktree-push-target-setup'

type ExecMock = Mock<GitRemoteExec>

const REPO = '/repo-root'
const FORK_SSH = 'git@github.com:contributor/orca.git'
const FORK_HTTPS = 'https://github.com/contributor/orca.git'

/** Real `git remote -v` shape: a fetch row and a push row per remote, tab-separated. */
export function renderRemoteVerbose(remotes: Record<string, string>): string {
  return Object.entries(remotes)
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join('\n')
}

// A stateful fake git: `remotes` maps name -> url. `remote add` mutates it so
// later lookups see the new remote, matching real git behavior. Defaults
// `symbolic-ref --short HEAD` to a real branch name, since a worktree's HEAD
// always resolves to one (mirrors real git, unlike an empty-stdout stub).
function makeRepoExec(
  remotes: Record<string, string>,
  checkedOutBranch = 'local-branch'
): ExecMock {
  return vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'symbolic-ref' && args[1] === '--short' && args[2] === 'HEAD') {
      return { stdout: `${checkedOutBranch}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: Object.keys(remotes).join('\n'), stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === '-v' && args.length === 2) {
      return { stdout: renderRemoteVerbose(remotes), stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2]!]
      if (!url) {
        throw new Error(`No such remote ${args[2]}`)
      }
      return { stdout: `${url}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'add') {
      // Why: name/url are always the last two args, regardless of `-t`/`--no-tags` flags.
      remotes[args.at(-2)!] = args.at(-1)!
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'remove') {
      delete remotes[args[2]!]
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
    remoteName: 'pr-contributor-orca',
    branchName: 'contributor/fix',
    remoteUrl: FORK_SSH,
    ...overrides
  }
}

describe('prepareWorktreePushTargetWithExec', () => {
  it('adds a new fork remote and fetches its head when none matches', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:stablyai/orca.git' })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([
      ['remote', 'add', '-t', 'contributor/fix', '--no-tags', 'pr-contributor-orca', FORK_SSH]
    ])
    expect(callsMatching(exec, ['fetch'])).toEqual([
      [
        'fetch',
        'pr-contributor-orca',
        '+refs/heads/contributor/fix*:refs/remotes/pr-contributor-orca/contributor/fix*'
      ]
    ])
    expect(result).toEqual({
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/fix',
      remoteUrl: FORK_SSH,
      remoteCreated: true
    })
  })

  it('records repo-local provenance on the remote it adds (#17828)', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:stablyai/orca.git' })

    await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    // Why: cleanup's ownership check must survive a store purge (worktree-push-target-cleanup.ts).
    // Narrowing the refspec (#17887) also writes `config` calls, so scope to the marker itself.
    expect(callsMatching(exec, ['config', 'remote.pr-contributor-orca.orca-created'])).toEqual([
      ['config', 'remote.pr-contributor-orca.orca-created', 'true']
    ])
  })

  it('does not record provenance when reusing an existing remote', async () => {
    const exec = makeRepoExec({
      origin: 'git@github.com:stablyai/orca.git',
      'pr-contributor-orca': FORK_HTTPS
    })

    await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['config', 'remote.pr-contributor-orca.orca-created'])).toEqual([])
  })

  it('reuses an existing remote pointing at the same fork (SSH vs HTTPS) without adding', async () => {
    const exec = makeRepoExec({
      origin: 'git@github.com:stablyai/orca.git',
      'pr-contributor-orca': FORK_HTTPS
    })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([])
    expect(callsMatching(exec, ['fetch'])).toEqual([
      [
        'fetch',
        'pr-contributor-orca',
        '+refs/heads/contributor/fix*:refs/remotes/pr-contributor-orca/contributor/fix*'
      ]
    ])
    // remoteCreated omitted because the predicate says no known worktree owns it.
    expect(result).toEqual({
      remoteName: 'pr-contributor-orca',
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
    const exec = makeRepoExec({ 'pr-contributor-orca': 'git@github.com:someone-else/orca.git' })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([
      ['remote', 'add', '-t', 'contributor/fix', '--no-tags', 'pr-contributor-orca-2', FORK_SSH]
    ])
    expect(result.remoteName).toBe('pr-contributor-orca-2')
    expect(result.remoteCreated).toBe(true)
  })

  it('strips an incoming remoteCreated flag and fetches the given remote when there is no remoteUrl', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:stablyai/orca.git' })

    const result = await prepareWorktreePushTargetWithExec(
      exec,
      REPO,
      { remoteName: 'origin', branchName: 'feature', remoteCreated: true },
      () => false
    )

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([])
    expect(callsMatching(exec, ['fetch'])).toEqual([
      ['fetch', 'origin', '+refs/heads/feature*:refs/remotes/origin/feature*']
    ])
    expect(result).toEqual({ remoteName: 'origin', branchName: 'feature' })
  })
})

describe('findRemoteForUrl', () => {
  it('matches by GitHub owner/repo across URL protocols', async () => {
    const exec = makeRepoExec({
      origin: 'git@github.com:stablyai/orca.git',
      fork: FORK_SSH
    })
    await expect(findRemoteForUrl(exec, REPO, FORK_HTTPS)).resolves.toBe('fork')
  })

  it('returns null when no remote points at the fork', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:stablyai/orca.git' })
    await expect(findRemoteForUrl(exec, REPO, FORK_SSH)).resolves.toBeNull()
  })
})

describe('remoteAlreadyMatchesUrl', () => {
  it('matches an exact URL', async () => {
    const exec = makeRepoExec({ 'pr-contributor-orca': FORK_SSH })
    await expect(
      remoteAlreadyMatchesUrl(exec, REPO, 'pr-contributor-orca', FORK_SSH)
    ).resolves.toBe(true)
  })

  it('matches by GitHub owner/repo across URL protocols', async () => {
    const exec = makeRepoExec({ 'pr-contributor-orca': FORK_HTTPS })
    await expect(
      remoteAlreadyMatchesUrl(exec, REPO, 'pr-contributor-orca', FORK_SSH)
    ).resolves.toBe(true)
  })

  it('returns false when the named remote points elsewhere', async () => {
    const exec = makeRepoExec({
      'pr-contributor-orca': 'git@github.com:someone-else/orca.git'
    })
    await expect(
      remoteAlreadyMatchesUrl(exec, REPO, 'pr-contributor-orca', FORK_SSH)
    ).resolves.toBe(false)
  })

  it('returns false when the named remote does not exist', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:stablyai/orca.git' })
    await expect(
      remoteAlreadyMatchesUrl(exec, REPO, 'pr-contributor-orca', FORK_SSH)
    ).resolves.toBe(false)
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
      ['branch', '--set-upstream-to', 'pr-contributor-orca/contributor/fix', 'local-branch'],
      '/wt/path'
    )
    expect(result).toBe(target)
  })
})

describe('restoreUpstreamAfterMaterialize', () => {
  it('points the checked-out branch upstream at the fork remote', async () => {
    const exec = makeRepoExec({}, 'local-branch')
    const target = forkTarget()

    const result = await restoreUpstreamAfterMaterialize(exec, '/wt/path', target)

    expect(exec).toHaveBeenCalledWith(
      ['branch', '--set-upstream-to', 'pr-contributor-orca/contributor/fix', 'local-branch'],
      '/wt/path'
    )
    expect(result).toBe(target)
  })

  it('is a no-op when the target has no remoteUrl', async () => {
    const exec = makeRepoExec({}, 'local-branch')
    const target: GitPushTarget = { remoteName: 'origin', branchName: 'feature' }

    const result = await restoreUpstreamAfterMaterialize(exec, '/wt/path', target)

    expect(callsMatching(exec, ['branch', '--set-upstream-to'])).toEqual([])
    expect(result).toBe(target)
  })

  it('is a no-op when HEAD is detached (no checked-out branch)', async () => {
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        throw new Error('fatal: ref HEAD is not a symbolic ref')
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()

    const result = await restoreUpstreamAfterMaterialize(exec, '/wt/path', target)

    expect(callsMatching(exec, ['branch', '--set-upstream-to'])).toEqual([])
    expect(result).toBe(target)
  })
})

describe('prepareWorktreePushTargetWithExec rollback', () => {
  it('removes the remote it just added when the fetch fails', async () => {
    const remotes: Record<string, string> = { origin: 'git@github.com:stablyai/orca.git' }
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'fetch') {
        throw new Error('network unreachable')
      }
      return makeRepoExec(remotes)(args, REPO)
    })

    await expect(
      prepareWorktreePushTargetWithExec(
        exec,
        REPO,
        { remoteName: 'pr-contributor-orca', branchName: 'contributor/fix', remoteUrl: FORK_SSH },
        () => false
      )
    ).rejects.toThrow('network unreachable')

    expect(callsMatching(exec, ['remote', 'remove'])).toEqual([
      ['remote', 'remove', 'pr-contributor-orca']
    ])
    expect(remotes).not.toHaveProperty('pr-contributor-orca')
  })

  it('keeps a reused remote Orca did not add when the fetch fails', async () => {
    const remotes: Record<string, string> = {
      origin: 'git@github.com:stablyai/orca.git',
      existing: FORK_SSH
    }
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'fetch') {
        throw new Error('network unreachable')
      }
      return makeRepoExec(remotes)(args, REPO)
    })

    await expect(
      prepareWorktreePushTargetWithExec(
        exec,
        REPO,
        { remoteName: 'pr-contributor-orca', branchName: 'contributor/fix', remoteUrl: FORK_SSH },
        () => false
      )
    ).rejects.toThrow('network unreachable')

    expect(callsMatching(exec, ['remote', 'remove'])).toEqual([])
    expect(remotes.existing).toBe(FORK_SSH)
  })

  // Regression: the rollback used to fire on inherited ownership, deleting a
  // remote a live sibling worktree was still pushing through.
  it('keeps a reused remote a sibling worktree owns when the fetch fails', async () => {
    const remotes: Record<string, string> = {
      origin: 'git@github.com:stablyai/orca.git',
      'pr-contributor-orca': FORK_HTTPS
    }
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'fetch') {
        throw new Error('network unreachable')
      }
      return makeRepoExec(remotes)(args, REPO)
    })

    await expect(
      prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => true)
    ).rejects.toThrow('network unreachable')

    expect(callsMatching(exec, ['remote', 'remove'])).toEqual([])
    expect(remotes['pr-contributor-orca']).toBe(FORK_HTTPS)
  })
})
