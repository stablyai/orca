import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import { gitExecFileAsync } from './runner'
import { isShowRefNoMatchError } from './exact-ref-probe'
import { hasCommitObjectViaGitExec } from './commit-object-ref'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'

type GitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

/** Return the probe's commit OID so callers need not resolve it again. */
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

/** Compare resolved qualified refs so aliases such as main and refs/heads/main share one base. */
export function resolveLocalWorktreeBaseRef(
  repoPath: string,
  baseRef: string,
  options: GitExecOptions = {}
): Promise<string> {
  return resolveWorktreeAddBaseRef(baseRef, (qualifiedRef) =>
    hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
  )
}

/** Creation and prefetch share this presence check so they agree on reusable local bases. */
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

/** Exact ref probes preserve unknown on execution failure; inject the runner to support relay hosts too. */
export async function probeWorktreeBaseRefPresence(
  runGit: (args: string[]) => Promise<{ stdout: string }>,
  qualifiedRef: string
): Promise<WorktreeBaseRefPresence> {
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
