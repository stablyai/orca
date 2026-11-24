import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  getErrorCode,
  gitExecOptions,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'

// Bound default fan-out across simultaneous creates; older Git ignores the key (2.32+).
const PARALLEL_CHECKOUT_GIT_ARGS = ['-c', 'checkout.workers=4'] as const

/** Parallel checkout args unless checkout.workers is configured at any scope for this repo and host. */
export async function checkoutWorkersGitArgs(
  cwd: string,
  options: GitWorktreeExecOptions = {}
): Promise<string[]> {
  try {
    await gitExecFileAsync(['config', '--get', 'checkout.workers'], gitExecOptions(cwd, options))
    return []
  } catch (error) {
    // Exit 1 means unset; other failures keep Git's own default rather than block the checkout.
    return getErrorCode(error) === '1' ? [...PARALLEL_CHECKOUT_GIT_ARGS] : []
  }
}
