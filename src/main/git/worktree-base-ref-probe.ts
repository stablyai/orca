import { gitExecFileAsync } from './runner'
import { isShowRefNoMatchError } from './exact-ref-probe'
import { hasCommitObjectViaGitExec } from './commit-object-ref'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'

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

/**
 * The qualified ref a worktree base names in this repo, or the base unchanged when nothing
 * matches. Callers that key on a base must compare this, not the raw string, or `main` and
 * `refs/heads/main` look like different bases.
 */
export function resolveLocalWorktreeBaseRef(
  repoPath: string,
  baseRef: string,
  options: GitExecOptions = {}
): Promise<string> {
  return resolveWorktreeAddBaseRef(baseRef, (qualifiedRef) =>
    hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
  )
}

/**
 * Whether a worktree base — a qualified ref, a short branch or remote name, or a
 * full commit id — already resolves in this repo's own object/ref store.
 *
 * Single copy on purpose: the create path, the speculative create prefetch and
 * the remote-repo create path must agree on what counts as a local base, or the
 * warm-up prepares a checkout create then rejects.
 */
export async function hasLocalWorktreeBaseRef(
  repoPath: string,
  baseRef: string,
  options: GitExecOptions = {}
): Promise<boolean> {
  const refExists = (qualifiedRef: string) =>
    hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasCommitObjectViaGitExec(
    (gitArgs) => gitExecFileAsync(gitArgs, { cwd: repoPath, ...options }),
    baseRef
  )
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
