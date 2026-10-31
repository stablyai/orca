import { isNoUpstreamError, stripCredentialsFromMessage } from '../../shared/git-remote-error'
import {
  resolveEffectiveGitUpstream,
  type GitCommandRunner
} from '../../shared/git-effective-upstream'

export type GitExec = GitCommandRunner

export type BranchUpstreamProbe =
  | { outcome: 'has-upstream' }
  | { outcome: 'no-upstream' }
  | { outcome: 'probe-failed'; message: string }

/** Auto-renaming a branch with an effective upstream can strand its remote branch and open review. */
export async function probeBranchUpstream(exec: GitExec): Promise<BranchUpstreamProbe> {
  try {
    const upstream = await resolveEffectiveGitUpstream(exec)
    return { outcome: upstream !== null ? 'has-upstream' : 'no-upstream' }
  } catch (error) {
    if (isNoUpstreamError(error)) {
      return { outcome: 'no-upstream' }
    }
    // Probe failures prove neither presence nor absence; keep renaming retryable and scrub UI diagnostics.
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

/** Apply compute to suffixed leaves (-2, -3, …), excluding currentBranch from collisions. */
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

export async function renameCurrentBranch(exec: GitExec, newBranch: string): Promise<void> {
  await exec(['branch', '-m', newBranch])
}
