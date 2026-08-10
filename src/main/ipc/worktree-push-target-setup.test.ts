import { describe, expect, it, vi, type Mock } from 'vitest'
import type { GitPushTarget } from '../../shared/types'
import type { GitRemoteExec } from './worktree-push-target-cleanup'
import {
  acquireWorktreePushTargetPreparationLease,
  configureCreatedWorktreePushTargetWithExec,
  ensureUniqueRemoteName,
  findRemoteForUrl,
  prepareWorktreePushTargetWithExec
} from './worktree-push-target-setup'

type ExecMock = Mock<GitRemoteExec>

const REPO = '/repo-root'
const FORK_SSH = 'git@github.com:contributor/orca.git'
const FORK_HTTPS = 'https://github.com/contributor/orca.git'

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
    remoteName: 'pr-contributor-orca',
    branchName: 'contributor/fix',
    remoteUrl: FORK_SSH,
    ...overrides
  }
}

describe('prepareWorktreePushTargetWithExec', () => {
  it('serializes preparation for the same repository and canonical fork URL', async () => {
    const firstRelease = await acquireWorktreePushTargetPreparationLease(REPO, forkTarget())
    let secondAcquired = false
    const second = acquireWorktreePushTargetPreparationLease(
      REPO,
      forkTarget({ remoteUrl: FORK_HTTPS })
    ).then((release) => {
      secondAcquired = true
      return release
    })

    await Promise.resolve()
    expect(secondAcquired).toBe(false)

    firstRelease()
    const secondRelease = await second
    expect(secondAcquired).toBe(true)
    secondRelease()
  })

  it('allows different fork URLs to prepare concurrently', async () => {
    const firstRelease = await acquireWorktreePushTargetPreparationLease(REPO, forkTarget())

    const secondRelease = await acquireWorktreePushTargetPreparationLease(
      REPO,
      forkTarget({ remoteUrl: 'git@github.com:other/orca.git' })
    )

    secondRelease()
    firstRelease()
  })

  it('removes an aborted waiter from the preparation queue', async () => {
    const firstRelease = await acquireWorktreePushTargetPreparationLease(REPO, forkTarget())
    const controller = new AbortController()
    const second = acquireWorktreePushTargetPreparationLease(REPO, forkTarget(), {
      signal: controller.signal
    })

    controller.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })

    const third = acquireWorktreePushTargetPreparationLease(REPO, forkTarget())
    firstRelease()
    const thirdRelease = await third
    thirdRelease()
  })

  it('uses the caller deadline while waiting for the preparation lease', async () => {
    const firstRelease = await acquireWorktreePushTargetPreparationLease(REPO, forkTarget())
    const timeoutError = new Error('Worktree add and checkout timed out after 180000ms.')

    await expect(
      acquireWorktreePushTargetPreparationLease(REPO, forkTarget(), {
        remainingTimeoutMs: () => {
          throw timeoutError
        }
      })
    ).rejects.toBe(timeoutError)

    firstRelease()
  })

  it('adds a new fork remote and fetches its head when none matches', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:stablyai/orca.git' })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([
      ['remote', 'add', 'pr-contributor-orca', FORK_SSH]
    ])
    expect(callsMatching(exec, ['fetch'])).toEqual([
      [
        'fetch',
        'pr-contributor-orca',
        '+refs/heads/contributor/fix:refs/remotes/pr-contributor-orca/contributor/fix'
      ]
    ])
    expect(result).toEqual({
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/fix',
      remoteUrl: FORK_SSH,
      remoteCreated: true
    })
  })

  it('removes a newly added fork remote when its initial fetch fails', async () => {
    const remotes: Record<string, string> = { origin: 'git@github.com:stablyai/orca.git' }
    const exec = makeRepoExec(remotes)
    const baseExec = exec.getMockImplementation()!
    exec.mockImplementation(async (args, cwd) => {
      if (args[0] === 'fetch') {
        throw new Error('fetch failed')
      }
      if (args[0] === 'remote' && args[1] === 'remove') {
        delete remotes[args[2]!]
        return { stdout: '', stderr: '' }
      }
      return baseExec(args, cwd)
    })

    await expect(
      prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)
    ).rejects.toThrow('fetch failed')

    expect(callsMatching(exec, ['remote', 'remove'])).toEqual([
      ['remote', 'remove', 'pr-contributor-orca']
    ])
  })

  it('uses separate fetch and cleanup executors when provided', async () => {
    const exec = makeRepoExec({ origin: 'git@github.com:stablyai/orca.git' })
    const cleanupExec = vi.fn<GitRemoteExec>().mockResolvedValue({ stdout: '', stderr: '' })
    const fetchRemoteTrackingRef = vi.fn().mockRejectedValue(new Error('fetch timed out'))

    await expect(
      prepareWorktreePushTargetWithExec(
        exec,
        REPO,
        forkTarget(),
        () => false,
        cleanupExec,
        fetchRemoteTrackingRef
      )
    ).rejects.toThrow('fetch timed out')

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('pr-contributor-orca')
    expect(callsMatching(exec, ['fetch'])).toEqual([])
    expect(callsMatching(exec, ['remote', 'remove'])).toEqual([])
    expect(cleanupExec).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], REPO)
  })

  it('reconciles and removes a remote whose add response timed out', async () => {
    const remotes: Record<string, string> = { origin: 'git@github.com:stablyai/orca.git' }
    const exec = makeRepoExec(remotes)
    const baseExec = exec.getMockImplementation()!
    exec.mockImplementation(async (args, cwd) => {
      if (args[0] === 'remote' && args[1] === 'add') {
        remotes[args[2]!] = args[3]!
        throw Object.assign(new Error('Request "git.exec" timed out after 60000ms'), {
          code: 'SSH_MUX_REQUEST_TIMEOUT'
        })
      }
      return baseExec(args, cwd)
    })
    const cleanupExec = makeRepoExec(remotes)
    const baseCleanupExec = cleanupExec.getMockImplementation()!
    cleanupExec.mockImplementation(async (args, cwd) => {
      if (args[0] === 'remote' && args[1] === 'remove') {
        delete remotes[args[2]!]
        return { stdout: '', stderr: '' }
      }
      return baseCleanupExec(args, cwd)
    })

    await expect(
      prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false, cleanupExec)
    ).rejects.toThrow('timed out')

    expect(cleanupExec).toHaveBeenCalledWith(['remote', 'get-url', 'pr-contributor-orca'], REPO)
    expect(cleanupExec).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], REPO)
    expect(remotes).toEqual({ origin: 'git@github.com:stablyai/orca.git' })
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
        '+refs/heads/contributor/fix:refs/remotes/pr-contributor-orca/contributor/fix'
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

  it('does not remove a reused Orca-created remote when fetching it fails', async () => {
    const remotes = { 'fork-x': FORK_HTTPS }
    const exec = makeRepoExec(remotes)
    const baseExec = exec.getMockImplementation()!
    exec.mockImplementation(async (args, cwd) => {
      if (args[0] === 'fetch') {
        throw new Error('fetch failed')
      }
      return baseExec(args, cwd)
    })

    await expect(
      prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => true)
    ).rejects.toThrow('fetch failed')

    expect(callsMatching(exec, ['remote', 'remove'])).toEqual([])
    expect(remotes).toEqual({ 'fork-x': FORK_HTTPS })
  })

  it('disambiguates with a numeric suffix when the preferred remote name is taken by a different URL', async () => {
    const exec = makeRepoExec({ 'pr-contributor-orca': 'git@github.com:someone-else/orca.git' })

    const result = await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

    expect(callsMatching(exec, ['remote', 'add'])).toEqual([
      ['remote', 'add', 'pr-contributor-orca-2', FORK_SSH]
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
      ['fetch', 'origin', '+refs/heads/feature:refs/remotes/origin/feature']
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
