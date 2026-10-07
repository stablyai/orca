import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock:
    vi.fn<(args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>>()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  translateWslOutputPaths: (output: string) => output
}))

import {
  LOCAL_BASE_REF_REFRESH_WAIT_MS,
  refreshLocalBaseRefForWorktreeCreate
} from './worktree-base-refresh'

const INDEX_LOCK_ERROR = Object.assign(new Error('Command failed: git merge --ff-only'), {
  stderr:
    "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository"
})
const OWNER_WORKTREE_LIST = 'worktree /repo\nHEAD old-main\nbranch refs/heads/main\n'

type GitFake = {
  owner?: boolean
  mutate: () => Promise<{ stdout: string }>
  /** Whether local already contains the target when a failed move is re-checked. */
  localContainsTarget?: () => boolean
  ownerHead?: () => string
}

/** The git subcommand, past leading `-c key=value` and `--flag` globals. */
function commandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c') {
      index += 1
    } else if (!args[index].startsWith('-')) {
      return args[index]
    }
  }
  return ''
}

function installGitFake(fake: GitFake): void {
  let localMain = 'old-main'
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    const command = commandOf(args)
    if (command === 'rev-parse') {
      return { stdout: args[2] === 'refs/heads/main^{commit}' ? `${localMain}\n` : 'remote-main\n' }
    }
    if (command === 'rev-list') {
      return { stdout: '0\t3\n' }
    }
    if (command === 'status') {
      return { stdout: '' }
    }
    if (command === 'worktree') {
      return { stdout: fake.owner ? OWNER_WORKTREE_LIST : '' }
    }
    if (command === 'symbolic-ref') {
      return { stdout: `${fake.ownerHead?.() ?? 'refs/heads/main'}\n` }
    }
    if (command === 'merge-base') {
      if (fake.localContainsTarget?.()) {
        return { stdout: '' }
      }
      throw Object.assign(new Error('not an ancestor'), { code: 1 })
    }
    if (command === 'merge' || command === 'update-ref') {
      const result = await fake.mutate()
      localMain = 'remote-main'
      return result
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
}

function refresh(repoPath = '/repo') {
  return refreshLocalBaseRefForWorktreeCreate(repoPath, 'origin/main', 'refs/remotes/origin/main')
}

function mutationCalls(): string[][] {
  return gitExecFileAsyncMock.mock.calls
    .map(([args]) => args)
    .filter((args) => ['merge', 'update-ref', 'reset'].includes(commandOf(args)))
}

describe('refreshLocalBaseRefForWorktreeCreate lock contention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    gitExecFileAsyncMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('retries a fast-forward that lost the index.lock race and reports updated', async () => {
    const mutate = vi
      .fn()
      .mockRejectedValueOnce(INDEX_LOCK_ERROR)
      .mockResolvedValueOnce({ stdout: '' })
    installGitFake({ owner: true, mutate })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual({
      baseRef: 'origin/main',
      localBranch: 'main',
      status: 'updated',
      ownerWorktreePath: '/repo'
    })
    expect(mutationCalls().map(commandOf)).toEqual(['merge', 'merge'])
    expect(mutationCalls().map((args) => args.at(-1))).toEqual(['remote-main', 'remote-main'])
  })

  it('re-confirms the owner has the branch checked out before each retry', async () => {
    let symbolicRefReads = 0
    installGitFake({
      owner: true,
      mutate: () => Promise.reject(INDEX_LOCK_ERROR),
      // The user switches the owner checkout to another branch while the first attempt waits.
      ownerHead: () => (++symbolicRefReads >= 2 ? 'refs/heads/develop' : 'refs/heads/main')
    })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ status: 'skipped_error' })
    expect(mutationCalls()).toHaveLength(1)
  })

  it('reports updated without a warning when the lock never clears but local already reached the target', async () => {
    installGitFake({
      owner: true,
      mutate: () => Promise.reject(INDEX_LOCK_ERROR),
      // The concurrent lock holder fast-forwarded local itself.
      localContainsTarget: () => true
    })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ status: 'updated' })
    expect(mutationCalls()).toHaveLength(4)
  })

  it('reports skipped_error when the lock never clears and local is still behind', async () => {
    installGitFake({ owner: true, mutate: () => Promise.reject(INDEX_LOCK_ERROR) })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ status: 'skipped_error' })
    expect(mutationCalls()).toHaveLength(4)
  })

  it('does not retry a failure that is not lock contention', async () => {
    const casMismatch = Object.assign(new Error('Command failed: git update-ref'), {
      stderr: "fatal: cannot lock ref 'refs/heads/main': is at other-oid but expected old-main"
    })
    installGitFake({ mutate: () => Promise.reject(casMismatch) })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ status: 'skipped_error' })
    expect(mutationCalls()).toEqual([
      [
        'update-ref',
        '-m',
        'orca: fast-forward to refs/remotes/origin/main',
        'refs/heads/main',
        'remote-main',
        'old-main'
      ]
    ])
  })

  it('treats a lost update-ref race as success when someone else moved local to the target', async () => {
    const casMismatch = Object.assign(new Error('Command failed: git update-ref'), {
      stderr: "fatal: cannot lock ref 'refs/heads/main': is at remote-main but expected old-main"
    })
    installGitFake({ mutate: () => Promise.reject(casMismatch), localContainsTarget: () => true })

    await expect(refresh()).resolves.toEqual({
      baseRef: 'origin/main',
      localBranch: 'main',
      status: 'updated'
    })
    expect(mutationCalls()).toHaveLength(1)
  })

  it('skips the owner check and the move when local is already current', async () => {
    installGitFake({ owner: true, mutate: () => Promise.resolve({ stdout: '' }) })
    const base = gitExecFileAsyncMock.getMockImplementation()!
    gitExecFileAsyncMock.mockImplementation(async (args: string[], opts: { cwd: string }) =>
      args[0] === 'rev-parse' ? { stdout: 'remote-main\n' } : base(args, opts)
    )

    await expect(refresh()).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args[0])).toEqual([
      'rev-parse',
      'rev-parse'
    ])
  })

  it("runs the shared refresh without one create's abort signal or timeout", async () => {
    installGitFake({ owner: true, mutate: () => Promise.resolve({ stdout: '' }) })

    await refreshLocalBaseRefForWorktreeCreate(
      '/repo',
      'origin/main',
      'refs/remotes/origin/main',
      undefined,
      { wslDistro: 'Ubuntu', signal: new AbortController().signal, timeout: 8000 }
    )

    for (const [, options] of gitExecFileAsyncMock.mock.calls) {
      expect(options).toEqual({ cwd: expect.any(String), wslDistro: 'Ubuntu' })
    }
  })
})

describe('refreshLocalBaseRefForWorktreeCreate runs one refresh at a time per branch', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  // Local moves to the target once the (held) owner fast-forward finishes.
  function installRepoFake(repoPath: string) {
    let localOid = 'old-main'
    let finishMerge!: () => void
    const mergeStarted = new Promise<void>((resolve) => {
      gitExecFileAsyncMock.mockImplementation(async (args: string[], opts: { cwd: string }) => {
        const command = commandOf(args)
        if (opts.cwd.replace(/\/+$/, '') !== repoPath) {
          return { stdout: command === 'rev-parse' ? 'current\n' : '' }
        }
        if (command === 'rev-parse') {
          return { stdout: args[2]?.startsWith('refs/heads/') ? `${localOid}\n` : 'remote-main\n' }
        }
        if (command === 'rev-list') {
          return { stdout: '0\t3\n' }
        }
        if (command === 'worktree') {
          return { stdout: `worktree ${repoPath}\nHEAD ${localOid}\nbranch refs/heads/main\n` }
        }
        if (command === 'symbolic-ref') {
          return { stdout: 'refs/heads/main\n' }
        }
        if (command === 'merge') {
          resolve()
          await new Promise<void>((release) => {
            finishMerge = release
          })
          localOid = 'remote-main'
        }
        return { stdout: '' }
      })
    })
    return { mergeStarted, finishMerge: () => finishMerge() }
  }

  it('folds creates that arrive mid-refresh into one follow-up that finds local current', async () => {
    const repo = installRepoFake('/repo')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const first = refresh('/repo')
    const joiners = [refresh('/repo/'), refresh('/repo')]
    await repo.mergeStarted
    const callsWhileFirstMerges = gitExecFileAsyncMock.mock.calls.length
    repo.finishMerge()

    await expect(first).resolves.toMatchObject({ status: 'updated' })
    await expect(Promise.all(joiners)).resolves.toEqual([undefined, undefined])
    const commands = gitExecFileAsyncMock.mock.calls.map(([args]) => commandOf(args))
    // Nothing ran for the joiners while the first held the checkout; after its post-move check, one inspection for all.
    expect(commands.slice(0, callsWhileFirstMerges).filter((c) => c === 'rev-list')).toHaveLength(1)
    expect(commands.slice(callsWhileFirstMerges)).toEqual(['rev-parse', 'rev-parse', 'rev-parse'])
    expect(mutationCalls()).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not queue refreshes of different repos behind each other', async () => {
    const repo = installRepoFake('/repo')

    const first = refresh('/repo')
    await repo.mergeStarted
    await expect(refresh('/other')).resolves.toBeUndefined()
    repo.finishMerge()
    await expect(first).resolves.toMatchObject({ status: 'updated' })
  })

  it('stops waiting on a wedged refresh after the bound without starting a second move', async () => {
    vi.useFakeTimers()
    const repo = installRepoFake('/repo')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let secondResult: unknown = 'pending'

    const first = refresh('/repo')
    await repo.mergeStarted
    await vi.advanceTimersByTimeAsync(10_000)
    const second = refresh('/repo').then((result) => (secondResult = result))

    await vi.advanceTimersByTimeAsync(LOCAL_BASE_REF_REFRESH_WAIT_MS - 1)
    expect(secondResult).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(secondResult).toBeUndefined()
    await expect(first).resolves.toBeUndefined()
    expect(mutationCalls()).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopped waiting'))

    // Settle the wedged run so the follow-up finds local current and frees the slot.
    repo.finishMerge()
    await vi.runAllTimersAsync()
    await vi.waitFor(() => expect(gitExecFileAsyncMock.mock.calls.at(-1)?.[0][0]).toBe('rev-parse'))
    expect(mutationCalls()).toHaveLength(1)
    warn.mockRestore()
  })
})
