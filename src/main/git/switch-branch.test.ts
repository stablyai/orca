import { describe, expect, it } from 'vitest'
import {
  isDirtyOverwriteError,
  normalizeSwitchBranchExecError,
  switchGitBranch,
  type SwitchBranchExec,
  type SwitchBranchExecResult
} from './switch-branch'

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
    expect(calls[0][0]).toBe('stash')
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
})
