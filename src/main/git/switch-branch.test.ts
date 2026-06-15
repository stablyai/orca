import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SWITCH_BRANCH_STASH_LABEL } from '../../shared/git-branch-switch'
import {
  isDirtyOverwriteError,
  isNothingToStash,
  normalizeSwitchBranchExecError,
  runSwitchBranch,
  switchGitBranch,
  type SwitchBranchExec,
  type SwitchBranchExecResult
} from './switch-branch'

const runnerMocks = vi.hoisted(() => ({ gitExecFileAsync: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: runnerMocks.gitExecFileAsync }))
const sshMocks = vi.hoisted(() => ({ getSshGitProvider: vi.fn(() => null) }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: sshMocks.getSshGitProvider }))

const ok = (stdout = ''): SwitchBranchExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string, exitCode = 1): SwitchBranchExecResult => ({
  stdout: '',
  stderr,
  exitCode
})

function execScript(results: SwitchBranchExecResult[]): {
  exec: SwitchBranchExec
  calls: string[][]
} {
  const calls: string[][] = []
  let i = 0
  const exec: SwitchBranchExec = async (argv) => {
    calls.push(argv)
    return results[i++] ?? ok()
  }
  return { exec, calls }
}

beforeEach(() => {
  // Why: default to no SSH provider so local tests are unaffected; SSH tests
  // opt in with mockReturnValueOnce.
  sshMocks.getSshGitProvider.mockReset()
  sshMocks.getSshGitProvider.mockReturnValue(null)
  runnerMocks.gitExecFileAsync.mockReset()
})

describe('isNothingToStash', () => {
  it('detects the no-op message in stdout (case-insensitive)', () => {
    expect(isNothingToStash({ stdout: 'No local changes to save', stderr: '' })).toBe(true)
  })
  it('detects the no-op message in stderr (case-insensitive)', () => {
    expect(isNothingToStash({ stdout: '', stderr: 'NO LOCAL CHANGES TO SAVE' })).toBe(true)
  })
  it('returns false when something was stashed', () => {
    expect(isNothingToStash({ stdout: 'Saved working directory', stderr: '' })).toBe(false)
  })
})

describe('isDirtyOverwriteError', () => {
  it('matches tracked overwrite', () => {
    expect(
      isDirtyOverwriteError(
        'error: Your local changes to the following files would be overwritten by checkout:'
      )
    ).toBe(true)
  })
  it('matches untracked overwrite', () => {
    expect(
      isDirtyOverwriteError(
        'error: The following untracked working tree files would be overwritten by checkout:'
      )
    ).toBe(true)
  })
  it('matches the git switch overwrite variant', () => {
    expect(
      isDirtyOverwriteError(
        'error: Your local changes to the following files would be overwritten by switch:'
      )
    ).toBe(true)
  })
  it('ignores unrelated errors', () => {
    expect(isDirtyOverwriteError('fatal: invalid reference: nope')).toBe(false)
  })
})

describe('normalizeSwitchBranchExecError', () => {
  it('reads stderr and exit code from a thrown git error', () => {
    expect(normalizeSwitchBranchExecError({ stderr: 'boom', code: 128 })).toEqual({
      stdout: '',
      stderr: 'boom',
      exitCode: 128
    })
  })
  it('falls back to message and exit code 1', () => {
    expect(normalizeSwitchBranchExecError(new Error('nope'))).toEqual({
      stdout: '',
      stderr: 'nope',
      exitCode: 1
    })
  })
})

describe('switchGitBranch', () => {
  it('create mode runs git switch -c', async () => {
    const { exec, calls } = execScript([ok()])
    expect(await switchGitBranch(exec, { branch: 'feat', mode: 'create' })).toEqual({ ok: true })
    expect(calls).toEqual([['switch', '-c', 'feat']])
  })

  it('plain mode succeeds', async () => {
    const { exec, calls } = execScript([ok()])
    expect(await switchGitBranch(exec, { branch: 'main', mode: 'plain' })).toEqual({ ok: true })
    expect(calls).toEqual([['switch', 'main']])
  })

  it('plain mode reports dirty_conflict on overwrite error', async () => {
    const { exec } = execScript([fail('Your local changes would be overwritten by checkout')])
    expect(await switchGitBranch(exec, { branch: 'main', mode: 'plain' })).toEqual({
      ok: false,
      reason: 'dirty_conflict'
    })
  })

  it('plain mode reports failed on other errors', async () => {
    const { exec } = execScript([fail('fatal: invalid reference')])
    expect(await switchGitBranch(exec, { branch: 'nope', mode: 'plain' })).toEqual({
      ok: false,
      reason: 'failed',
      message: 'fatal: invalid reference'
    })
  })

  it('stash mode stashes, switches, then pops', async () => {
    const { exec, calls } = execScript([ok(), ok(), ok()])
    expect(await switchGitBranch(exec, { branch: 'main', mode: 'stash' })).toEqual({ ok: true })
    expect(calls[0]).toEqual([
      'stash',
      'push',
      '--include-untracked',
      '-m',
      SWITCH_BRANCH_STASH_LABEL
    ])
    expect(calls[1]).toEqual(['switch', 'main'])
    expect(calls[2]).toEqual(['stash', 'pop'])
  })

  it('stash mode restores the stash when the switch fails', async () => {
    const { exec, calls } = execScript([ok(), fail('fatal: boom'), ok()])
    expect(await switchGitBranch(exec, { branch: 'main', mode: 'stash' })).toEqual({
      ok: false,
      reason: 'failed',
      message: 'fatal: boom'
    })
    expect(calls[2]).toEqual(['stash', 'pop'])
  })

  it('stash mode reports stash_pop_conflict when pop fails', async () => {
    const { exec } = execScript([ok(), ok(), fail('CONFLICT')])
    expect(await switchGitBranch(exec, { branch: 'main', mode: 'stash' })).toEqual({
      ok: false,
      reason: 'stash_pop_conflict'
    })
  })

  it('stash mode skips the pop when nothing was stashed and the switch succeeds', async () => {
    const { exec, calls } = execScript([ok('No local changes to save'), ok()])
    expect(await switchGitBranch(exec, { branch: 'main', mode: 'stash' })).toEqual({ ok: true })
    expect(calls.length).toBe(2)
    expect(calls[1]).toEqual(['switch', 'main'])
  })

  it('stash mode skips the pop when nothing was stashed and the switch fails', async () => {
    const { exec, calls } = execScript([ok('No local changes to save'), fail('fatal: boom')])
    expect(await switchGitBranch(exec, { branch: 'main', mode: 'stash' })).toEqual({
      ok: false,
      reason: 'failed',
      message: 'fatal: boom'
    })
    expect(calls.length).toBe(2)
  })
})

describe('runSwitchBranch (local)', () => {
  it('runs git switch in the worktree and returns ok', async () => {
    runnerMocks.gitExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    const result = await runSwitchBranch({
      cwd: '/repo',
      connectionId: undefined,
      options: { branch: 'main', mode: 'plain' }
    })
    expect(result).toEqual({ ok: true })
    expect(runnerMocks.gitExecFileAsync).toHaveBeenCalledWith(['switch', 'main'], { cwd: '/repo' })
  })

  it('maps a rejected git switch into dirty_conflict', async () => {
    runnerMocks.gitExecFileAsync.mockRejectedValue(
      Object.assign(new Error('checkout failed'), {
        stderr: 'Your local changes would be overwritten by checkout',
        code: 1
      })
    )
    const result = await runSwitchBranch({
      cwd: '/repo',
      connectionId: undefined,
      options: { branch: 'main', mode: 'plain' }
    })
    expect(result).toEqual({ ok: false, reason: 'dirty_conflict' })
  })
})

describe('runSwitchBranch (SSH)', () => {
  it('runs git switch through the provider and returns ok', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    sshMocks.getSshGitProvider.mockReturnValueOnce({ exec } as never)
    const result = await runSwitchBranch({
      cwd: '/remote/repo',
      connectionId: 'conn-1',
      options: { branch: 'feature', mode: 'plain' }
    })
    expect(result).toEqual({ ok: true })
    expect(exec).toHaveBeenCalledWith(['switch', 'feature'], '/remote/repo')
  })

  it('maps a rejected provider exec into dirty_conflict', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('x'), {
          stderr: 'Your local changes would be overwritten by checkout'
        })
      )
    sshMocks.getSshGitProvider.mockReturnValueOnce({ exec } as never)
    const result = await runSwitchBranch({
      cwd: '/remote/repo',
      connectionId: 'conn-1',
      options: { branch: 'feature', mode: 'plain' }
    })
    expect(result).toEqual({ ok: false, reason: 'dirty_conflict' })
  })

  it('throws when the SSH provider is unavailable', async () => {
    sshMocks.getSshGitProvider.mockReturnValueOnce(null)
    await expect(
      runSwitchBranch({
        cwd: '/remote/repo',
        connectionId: 'conn-1',
        options: { branch: 'feature', mode: 'plain' }
      })
    ).rejects.toThrow('SSH git provider unavailable')
  })
})
