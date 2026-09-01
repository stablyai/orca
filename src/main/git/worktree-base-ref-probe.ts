import { gitExecFileAsync } from './runner'
import { isShowRefNoMatchError } from './exact-ref-probe'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'

type GitExecOptions = {
  wslDistro?: string
}

/**
 * Returns the probed commit oid, or null when the ref does not resolve.
 *
 * Why expose the oid: the probe already prints it, and callers that then need the
 * same ref's oid were re-spawning `rev-parse` for a value this call threw away.
 */
export async function resolveWorktreeBaseCommitOid(
  repoPath: string,
  qualifiedRef: string,
  options: GitExecOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`],
      {
        cwd: repoPath,
        ...options
      }
    )
    const oid = stdout.trim()
    return oid.length > 0 ? oid : null
  } catch {
    return null
  }
}

export async function hasWorktreeBaseCommitRef(
  repoPath: string,
  qualifiedRef: string,
  options: GitExecOptions = {}
): Promise<boolean> {
  return (await resolveWorktreeBaseCommitOid(repoPath, qualifiedRef, options)) !== null
}

export type WorktreeBaseRefPresence = 'present' | 'absent' | 'unknown'

/**
 * Distinguish "the ref does not exist" from "the probe itself failed".
 *
 * `show-ref --verify` is an exact lookup: exit 1 means a valid ref is absent,
 * while other failures (for example a broken repo or dead SSH transport) stay
 * inconclusive so callers can preserve their warning/error behavior.
 *
 * Executor-injected so the SSH path can route the same argv through the relay.
 */
export async function probeWorktreeBaseRefPresence(
  runGit: (args: string[]) => Promise<{ stdout: string }>,
  qualifiedRef: string
): Promise<WorktreeBaseRefPresence> {
  // Reject malformed persisted metadata before passing it to Git.
  if (!isSafeGitRefName(qualifiedRef)) {
    return 'unknown'
  }
  try {
    await runGit(['show-ref', '--verify', '--quiet', '--', qualifiedRef])
    return 'present'
  } catch (error) {
    return isShowRefNoMatchError(error) ? 'absent' : 'unknown'
  }
}
