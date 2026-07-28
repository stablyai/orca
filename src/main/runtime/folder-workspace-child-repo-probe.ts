import { gitExecFileAsync } from '../git/runner'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { localGitOptionsForTarget, type RuntimeGitTarget } from './orca-runtime-git'

const PROBE_TIMEOUT_MS = 15_000

/**
 * Does this child repo have staged changes — and can we even tell?
 *
 * Why not read this off `getStatus`: it is built for display, and two of its
 * display affordances are wrong for selection. It catches a failed status read
 * and resolves an empty result, and it caps entries (default 1000, surfaced as
 * `didHitLimit`). Under `getStatus`, "no staged entry" means *not staged*,
 * *unreadable*, or *truncated* — indistinguishable. Selection that cannot tell
 * those apart commits the wrong child repo and reports success (#6357).
 *
 * `diff --cached --quiet` has neither problem: no entry cap, and a broken index
 * exits 128 instead of looking clean. Throwing here is the point — the caller
 * fails closed rather than guessing.
 */
export async function probeChildRepoHasStagedChanges(target: RuntimeGitTarget): Promise<boolean> {
  // rc 0 = nothing staged, rc 1 = staged, anything else is a real failure.
  // Correct on an unborn HEAD too, unlike `diff --cached HEAD`.
  const { code, stderr } = await runChildRepoGit(target, ['diff', '--cached', '--quiet'])
  if (code === 0) {
    return false
  }
  if (code === 1) {
    return true
  }
  throw new Error(stderr.trim() || `git diff --cached exited with ${code}`)
}

/**
 * Throw unless this child repo's index is readable.
 *
 * Why reuse the staged probe for a conflict-state read: the conflict operation
 * still comes from `getStatus` (its gitdir-marker check is the only reliable way
 * to tell merge from rebase — `REBASE_HEAD` survives a *completed* rebase and
 * would report a phantom one). But that read swallows failures the same way, so
 * an unreadable repo would present as merely un-conflicted and quietly lose the
 * abort to a different repo. This turns that silence back into an error.
 */
export async function assertChildRepoIndexReadable(target: RuntimeGitTarget): Promise<void> {
  await probeChildRepoHasStagedChanges(target)
}

async function runChildRepoGit(
  target: RuntimeGitTarget,
  args: string[]
): Promise<{ code: number; stderr: string }> {
  if (target.connectionId) {
    const provider = getSshGitProvider(target.connectionId)
    if (!provider) {
      throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const result = await provider.execNonInteractive(
      'git',
      args,
      target.worktree.path,
      PROBE_TIMEOUT_MS
    )
    if (result.spawnError) {
      throw new Error(result.spawnError)
    }
    if (result.timedOut) {
      throw new Error(`git ${args.join(' ')} timed out after ${PROBE_TIMEOUT_MS}ms`)
    }
    // Why not default a null exit code to 0: a signal-killed probe would read as
    // "nothing staged" — the exact false negative this module exists to prevent.
    if (result.exitCode === null) {
      throw new Error(result.stderr.trim() || `git ${args.join(' ')} exited without a status`)
    }
    return { code: result.exitCode, stderr: result.stderr }
  }
  try {
    await gitExecFileAsync(args, {
      cwd: target.worktree.path,
      ...localGitOptionsForTarget(target)
    })
    return { code: 0, stderr: '' }
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown }
    // Why surface the code rather than rethrow: for this probe a non-zero exit is
    // an answer, not a fault. A spawn failure carries no numeric code and rethrows.
    if (typeof failure.code !== 'number') {
      throw error
    }
    return {
      code: failure.code,
      stderr: typeof failure.stderr === 'string' ? failure.stderr : ''
    }
  }
}
