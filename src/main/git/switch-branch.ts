import type { SwitchBranchOptions, SwitchBranchResult } from '../../shared/git-branch-switch'
import { SWITCH_BRANCH_STASH_LABEL } from '../../shared/git-branch-switch'
import { gitExecFileAsync } from './runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

export type SwitchBranchExecResult = { stdout: string; stderr: string; exitCode: number }
// Why: this MUST resolve (never throw) — non-zero git exits are reported via
// `exitCode`, not rejection. The local/SSH adapters in runSwitchBranch convert a
// rejected git call into this shape with normalizeSwitchBranchExecError, which
// keeps switchGitBranch's stash-restore path reachable on a failed switch.
export type SwitchBranchExec = (argv: string[]) => Promise<SwitchBranchExecResult>

// Why: git emits two distinct overwrite errors — one for tracked changes, one
// for untracked files — and both mean "stash first". Match either so smart
// checkout offers the stash path in both cases.
export function isDirtyOverwriteError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return (
    s.includes('would be overwritten by checkout') ||
    s.includes('would be overwritten by switch') ||
    s.includes('please commit your changes or stash them')
  )
}

// Why: both local gitExecFileAsync and the SSH provider reject on a non-zero
// exit, attaching stderr (and, locally, a numeric `code`). Normalize either
// rejection into the result shape the orchestrator branches on.
export function normalizeSwitchBranchExecError(err: unknown): SwitchBranchExecResult {
  const e = err as { stderr?: unknown; stdout?: unknown; code?: unknown; message?: unknown }
  const stderr =
    (typeof e?.stderr === 'string' && e.stderr) ||
    (typeof e?.message === 'string' && e.message) ||
    ''
  const exitCode = typeof e?.code === 'number' && e.code !== 0 ? e.code : 1
  const stdout = typeof e?.stdout === 'string' ? e.stdout : ''
  return { stdout, stderr, exitCode }
}

// Why: `git stash push` exits 0 even when there's nothing to stash; detecting
// that no-op prevents a later `stash pop` from applying an unrelated stash.
export function isNothingToStash(result: { stdout: string; stderr: string }): boolean {
  const text = `${result.stdout} ${result.stderr}`.toLowerCase()
  return text.includes('no local changes to save')
}

export async function switchGitBranch(
  exec: SwitchBranchExec,
  options: SwitchBranchOptions
): Promise<SwitchBranchResult> {
  if (options.mode === 'create') {
    // Why: -c branches from the current commit, so it never touches working-tree
    // files and cannot hit the dirty-overwrite path.
    const created = await exec(['switch', '-c', options.branch])
    return created.exitCode === 0
      ? { ok: true }
      : { ok: false, reason: 'failed', message: created.stderr.trim() }
  }

  if (options.mode === 'plain') {
    const switched = await exec(['switch', options.branch])
    if (switched.exitCode === 0) {
      return { ok: true }
    }
    if (isDirtyOverwriteError(switched.stderr)) {
      return { ok: false, reason: 'dirty_conflict' }
    }
    return { ok: false, reason: 'failed', message: switched.stderr.trim() }
  }

  // mode === 'stash': stash → switch → pop
  const stashed = await exec([
    'stash',
    'push',
    '--include-untracked',
    '-m',
    SWITCH_BRANCH_STASH_LABEL
  ])
  if (stashed.exitCode !== 0) {
    return { ok: false, reason: 'failed', message: stashed.stderr.trim() }
  }
  const createdStash = !isNothingToStash(stashed)
  const switched = await exec(['switch', options.branch])
  if (switched.exitCode !== 0) {
    // Why: only restore if we actually stashed — otherwise `pop` would apply an
    // unrelated pre-existing stash and strand foreign changes here.
    if (createdStash) {
      await exec(['stash', 'pop'])
    }
    return { ok: false, reason: 'failed', message: switched.stderr.trim() }
  }
  // Why: nothing was stashed, so there is nothing to pop; popping would apply a
  // foreign stash.
  if (!createdStash) {
    return { ok: true }
  }
  const popped = await exec(['stash', 'pop'])
  if (popped.exitCode !== 0) {
    return { ok: false, reason: 'stash_pop_conflict' }
  }
  return { ok: true }
}

// Why: both entry points (local preload IPC and the runtime RPC) need the same
// local-vs-SSH exec wiring; centralize it so the two paths cannot drift.
export async function runSwitchBranch(input: {
  cwd: string
  connectionId: string | undefined
  options: SwitchBranchOptions
}): Promise<SwitchBranchResult> {
  const { cwd, connectionId, options } = input
  if (connectionId) {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error('SSH git provider unavailable')
    }
    const exec: SwitchBranchExec = async (argv) => {
      try {
        const { stdout, stderr } = await provider.exec(argv, cwd)
        return { stdout, stderr, exitCode: 0 }
      } catch (err) {
        return normalizeSwitchBranchExecError(err)
      }
    }
    return switchGitBranch(exec, options)
  }
  const exec: SwitchBranchExec = async (argv) => {
    try {
      const { stdout, stderr } = await gitExecFileAsync(argv, { cwd })
      return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 }
    } catch (err) {
      return normalizeSwitchBranchExecError(err)
    }
  }
  return switchGitBranch(exec, options)
}
