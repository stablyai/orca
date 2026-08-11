import { isNoUpstreamError, stripCredentialsFromMessage } from '../../shared/git-remote-error'
import {
  resolveEffectiveGitUpstream,
  type GitCommandRunner
} from '../../shared/git-effective-upstream'

/**
 * Git runner so branch-rename logic works identically for local worktrees
 * (`gitExecFileAsync`) and SSH worktrees (`provider.exec`). Same contract the
 * shared upstream-status helpers use.
 */
export type GitExec = GitCommandRunner

export type BranchUpstreamProbe =
  | { outcome: 'has-upstream' }
  | { outcome: 'no-upstream' }
  | { outcome: 'probe-failed'; message: string }

/**
 * Whether the branch has an upstream — i.e. it has been pushed or is tracking
 * a remote. Auto-rename refuses to touch such a branch because `git branch -m`
 * would orphan the remote branch and break any open PR.
 */
export async function probeBranchUpstream(exec: GitExec): Promise<BranchUpstreamProbe> {
  try {
    const upstream = await resolveEffectiveGitUpstream(exec)
    return { outcome: upstream !== null ? 'has-upstream' : 'no-upstream' }
  } catch (error) {
    if (isNoUpstreamError(error)) {
      return { outcome: 'no-upstream' }
    }
    // Why: an unexpected failure is not proof either way — report it as its own
    // outcome so callers skip the rename but stay retryable (issue #7808).
    // The message surfaces in the UI, so scrub credential-bearing remote URLs.
    return {
      outcome: 'probe-failed',
      message: stripCredentialsFromMessage(error instanceof Error ? error.message : String(error))
    }
  }
}

async function localBranchExists(exec: GitExec, branch: string): Promise<boolean> {
  try {
    await exec(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a branch name that doesn't collide with an existing local branch by
 * appending `-2`, `-3`, … to the leaf — the same suffixing worktree creation
 * uses. `compute` applies the configured prefix to a leaf. The branch currently
 * being renamed away from is never treated as a collision.
 */
export async function resolveUniqueBranchName(
  exec: GitExec,
  leaf: string,
  compute: (leaf: string) => string,
  currentBranch: string,
  maxAttempts = 100
): Promise<string | null> {
  const isAvailable = async (candidate: string): Promise<boolean> =>
    candidate === currentBranch || !(await localBranchExists(exec, candidate))

  const first = compute(leaf)
  if (await isAvailable(first)) {
    return first
  }
  for (let suffix = 2; suffix <= maxAttempts; suffix += 1) {
    const candidate = compute(`${leaf}-${suffix}`)
    if (await isAvailable(candidate)) {
      return candidate
    }
  }
  return null
}

/** Rename the currently checked-out branch (`git branch -m <newBranch>`). */
export async function renameCurrentBranch(exec: GitExec, newBranch: string): Promise<void> {
  await exec(['branch', '-m', newBranch])
}
