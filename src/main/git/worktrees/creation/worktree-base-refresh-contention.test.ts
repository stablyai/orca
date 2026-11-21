import { mkdtempSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ExecOpts = { cwd: string; beforeStart?: () => Promise<boolean> }
const { gitExecFileAsyncMock, stall } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn<(args: string[], opts: ExecOpts) => Promise<{ stdout: string }>>(),
  // Holds the read of a file ending in `path` once `skip` earlier reads have passed.
  stall: { path: '', skip: 0, opens: 0, started: () => {}, release: () => {} }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const open: typeof actual.open = (path, ...rest) => {
    if (String(path).replaceAll('\\', '/').includes('/refs/')) {
      stall.opens += 1
    }
    if (
      stall.path &&
      String(path).replaceAll('\\', '/').endsWith(stall.path) &&
      stall.skip-- <= 0
    ) {
      stall.path = ''
      stall.started()
      return new Promise((resolve) => {
        stall.release = () => resolve(actual.open(path, ...rest))
      })
    }
    return actual.open(path, ...rest)
  }
  return { ...actual, open }
})

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../command-runner/host-routing/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: (output: string) => output
}))

import {
  getLocalBaseRefUpdateSuggestionForWorktreeCreate,
  LOCAL_BASE_REF_REFRESH_WAIT_MS,
  PRE_WRITE_CHECK_TIMEOUT_MS,
  refreshLocalBaseRefForWorktreeCreate
} from './worktree-base-refresh'

// A real, empty Git common dir: no rebase or bisect reserves main.
const commonDir = mkdtempSync(join(tmpdir(), 'orca-refresh-contention-common-'))
afterAll(() => rmSync(commonDir, { recursive: true, force: true }))

type GitFake = {
  mutate: () => Promise<{ stdout: string }>
  /** Whether local already contains the target when a failed move is re-checked. */
  localContainsTarget?: () => boolean
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
  gitExecFileAsyncMock.mockImplementation(async (args: string[], opts: ExecOpts) => {
    const command = commandOf(args)
    if (command === 'rev-parse') {
      if (args[1] === '--git-common-dir') {
        return { stdout: `${commonDir}\n` }
      }
      return { stdout: args[2] === 'refs/heads/main^{commit}' ? `${localMain}\n` : 'remote-main\n' }
    }
    if (command === 'rev-list') {
      return { stdout: '0\t3\n' }
    }
    if (command === 'config') {
      throw Object.assign(new Error('key unset'), { code: 1 })
    }
    if (command === 'merge-base') {
      // Local is still an ancestor of the target unless asked whether it already contains it.
      if (args[2] !== 'remote-main' || fake.localContainsTarget?.()) {
        return { stdout: '' }
      }
      throw Object.assign(new Error('not an ancestor'), { code: 1 })
    }
    if (command === 'update-ref') {
      // As the runner does once admitted.
      if ((await opts.beforeStart?.()) === false) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
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
    gitExecFileAsyncMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('gives back the Git slot and skips the write when a file stalls during the admitted check', async () => {
    vi.useFakeTimers()
    const mutate = vi.fn(() => Promise.resolve({ stdout: '' }))
    installGitFake({ mutate })
    const started = new Promise<void>((resolve) => {
      stall.started = resolve
    })
    // The inspection reads main's ref once before admission; the admitted check's read stalls.
    Object.assign(stall, { path: 'refs/heads/main', skip: 1 })

    const result = refresh()
    await started
    await vi.advanceTimersByTimeAsync(PRE_WRITE_CHECK_TIMEOUT_MS)
    await result
    // A later write check for the stalled repo declines at once, without reading.
    const opensWhileStalled = stall.opens
    await refresh()
    const opensBeforeRelease = stall.opens
    stall.release()
    await vi.runAllTimersAsync()

    expect(mutate).not.toHaveBeenCalled()
    // Only the second refresh's own inspection read main's ref; the released check reads nothing more.
    expect(opensBeforeRelease - opensWhileStalled).toBe(1)
    expect(stall.opens).toBe(opensBeforeRelease)
  })

  it('does not retry a failure that is not lock contention', async () => {
    const casMismatch = Object.assign(new Error('Command failed: git update-ref'), {
      stderr: "fatal: cannot lock ref 'refs/heads/main': is at other-oid but expected old-main"
    })
    installGitFake({ mutate: () => Promise.reject(casMismatch) })

    await expect(refresh()).resolves.toMatchObject({ status: 'skipped_error' })
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
})

describe('refreshLocalBaseRefForWorktreeCreate runs one refresh at a time per branch', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  function installRepoFake(repoPath: string) {
    let localOid = 'old-main'
    let finishMove!: () => void
    const moveStarted = new Promise<void>((resolve) => {
      gitExecFileAsyncMock.mockImplementation(async (args: string[], opts: { cwd: string }) => {
        const command = commandOf(args)
        if (opts.cwd.replace(/\/+$/, '') !== repoPath) {
          return { stdout: command === 'rev-parse' ? 'current\n' : '' }
        }
        if (command === 'rev-parse') {
          if (args[1] === '--git-common-dir') {
            return { stdout: `${commonDir}\n` }
          }
          return { stdout: args[2]?.startsWith('refs/heads/') ? `${localOid}\n` : 'remote-main\n' }
        }
        if (command === 'rev-list') {
          return { stdout: '0\t3\n' }
        }
        if (command === 'update-ref') {
          resolve()
          await new Promise<void>((release) => {
            finishMove = release
          })
          localOid = 'remote-main'
        }
        return { stdout: '' }
      })
    })
    return { moveStarted, finishMove: () => finishMove() }
  }

  it('folds creates that arrive mid-refresh into one follow-up that finds local current', async () => {
    const repo = installRepoFake('/repo')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const first = refresh('/repo')
    const joiners = [refresh('/repo/'), refresh('/repo')]
    await repo.moveStarted
    const callsWhileFirstMoves = gitExecFileAsyncMock.mock.calls.length
    repo.finishMove()

    await expect(first).resolves.toMatchObject({ status: 'updated' })
    await expect(Promise.all(joiners)).resolves.toEqual([undefined, undefined])
    const commands = gitExecFileAsyncMock.mock.calls.map(([args]) => commandOf(args))
    // Joiners share a follow-up inspection only after the first run releases the branch.
    expect(commands.slice(0, callsWhileFirstMoves).filter((c) => c === 'rev-list')).toHaveLength(1)
    expect(commands.slice(callsWhileFirstMoves)).toEqual(['rev-parse', 'rev-parse'])
    expect(mutationCalls()).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not queue refreshes of different repos behind each other', async () => {
    const repo = installRepoFake('/repo')

    const first = refresh('/repo')
    await repo.moveStarted
    await expect(refresh('/other')).resolves.toBeUndefined()
    repo.finishMove()
    await expect(first).resolves.toMatchObject({ status: 'updated' })
  })

  it('stops waiting on a wedged refresh after the bound without starting a second move', async () => {
    vi.useFakeTimers()
    const repo = installRepoFake('/repo')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let secondResult: unknown = 'pending'

    const first = refresh('/repo')
    await repo.moveStarted
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

    repo.finishMove()
    await vi.runAllTimersAsync()
    await vi.waitFor(() => expect(gitExecFileAsyncMock.mock.calls.at(-1)?.[0][0]).toBe('rev-parse'))
    expect(mutationCalls()).toHaveLength(1)
    warn.mockRestore()
  })
})

it('gives up on a stalled update suggestion after the bound instead of holding the create', async () => {
  vi.useFakeTimers()
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(() => new Promise(() => {}))
  let result: unknown = 'pending'

  const suggestion = getLocalBaseRefUpdateSuggestionForWorktreeCreate(
    '/repo',
    'origin/main',
    'refs/remotes/origin/main'
  ).then((value) => (result = value))
  await vi.advanceTimersByTimeAsync(LOCAL_BASE_REF_REFRESH_WAIT_MS - 1)
  expect(result).toBe('pending')
  await vi.advanceTimersByTimeAsync(1)
  await suggestion

  expect(result).toBeUndefined()
  vi.useRealTimers()
})

it('stops an abandoned update suggestion before it runs any more Git', async () => {
  vi.useFakeTimers()
  gitExecFileAsyncMock.mockReset()
  installGitFake({ mutate: () => Promise.resolve({ stdout: '' }) })
  const started = new Promise<void>((resolve) => {
    stall.started = resolve
  })
  Object.assign(stall, { path: 'refs/heads/main', skip: 0 })

  // Its own repo: the stalled suggestion above still holds `/repo`.
  const suggestion = getLocalBaseRefUpdateSuggestionForWorktreeCreate(
    '/repo-abandoned',
    'origin/main',
    'refs/remotes/origin/main'
  )
  await started
  await vi.advanceTimersByTimeAsync(LOCAL_BASE_REF_REFRESH_WAIT_MS)
  await expect(suggestion).resolves.toBeUndefined()
  const callsWhenAbandoned = gitExecFileAsyncMock.mock.calls.length
  stall.release()
  await vi.runAllTimersAsync()

  expect(gitExecFileAsyncMock.mock.calls.length).toBe(callsWhenAbandoned)
  vi.useRealTimers()
})
