import { gitExecFileAsync } from './runner'
import {
  getErrorCode,
  gitExecOptions,
  type GitWorktreeExecOptions
} from './worktree-operation-options'

// Git checks out with one worker by default; 0 means one per core (Git 2.32+; older Git ignores the key).
const PARALLEL_CHECKOUT_GIT_ARGS = ['-c', 'checkout.workers=0'] as const

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
