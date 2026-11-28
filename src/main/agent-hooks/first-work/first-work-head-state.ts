import { isQuietGitControlFlowExit } from '../../git/command-runner/host-routing/git-command-resolution'
import type { GitExec } from '../../git/worktrees/checkout/branch-rename'

export type FirstWorkHeadState =
  | { kind: 'branch'; name: string }
  | { kind: 'detached' }
  /** Anything Git did not positively report: retryable, never paused. */
  | { kind: 'unknown' }

const BRANCH_REF_PREFIX = 'refs/heads/'

/** Two reads on the final routed result tell a detached HEAD apart from ordinary launcher failures. */
export async function readFirstWorkHeadState(exec: GitExec): Promise<FirstWorkHeadState> {
  let ref: string
  try {
    ref = (await exec(['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim()
  } catch (error) {
    return isQuietSymbolicRefMiss(error) && (await confirmsDetachedHead(exec))
      ? { kind: 'detached' }
      : { kind: 'unknown' }
  }
  const name = ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ''
  return name ? { kind: 'branch', name } : { kind: 'unknown' }
}

function isQuietSymbolicRefMiss(error: unknown): boolean {
  if (!isQuietGitControlFlowExit(error) || typeof error !== 'object' || error === null) {
    return false
  }
  const signaled = 'signal' in error && error.signal != null
  const killed = 'killed' in error && error.killed === true
  return !signaled && !killed && !('wslHostFailure' in error)
}

async function confirmsDetachedHead(exec: GitExec): Promise<boolean> {
  try {
    const { stdout } = await exec(['rev-parse', '--symbolic-full-name', 'HEAD'])
    return stdout.trim() === 'HEAD'
  } catch {
    return false
  }
}
