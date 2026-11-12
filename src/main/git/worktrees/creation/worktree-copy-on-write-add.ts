import { windowsLongPathGitArgs } from '../../../../shared/windows-long-path-git-args'
import { checkoutWorkersGitArgs } from './checkout-workers-git-args'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { addWorktree } from './worktree-add'
import { createWorktreeCheckoutProgressReader } from './worktree-checkout-progress'
import {
  cloneMainCheckoutIntoWorktree,
  resolveCopyOnWriteCheckout
} from './worktree-copy-on-write-checkout'
import { rollBackCreatedWorktree } from './worktree-create-rollback'
import type { AddWorktreeOptions, AddWorktreeResult } from '../worktree-operation-options'
import { gitExecOptions, resolveWorktreeAddTimeoutMs } from '../worktree-operation-options'

/**
 * `addWorktree`, but on APFS and reflink filesystems files that match the main checkout are
 * cloned from it instead of written, so they share disk blocks until either side changes.
 */
export async function addWorktreeWithCopyOnWriteCheckout(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string | undefined,
  refreshLocalBaseRef: boolean,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  const method = await resolveCopyOnWriteCheckout(repoPath, worktreePath, options)
  if (!method) {
    return addWorktree(
      repoPath,
      worktreePath,
      branch,
      baseBranch,
      refreshLocalBaseRef,
      false,
      options
    )
  }
  const addResult = await addWorktree(
    repoPath,
    worktreePath,
    branch,
    baseBranch,
    refreshLocalBaseRef,
    true,
    options
  )
  const checkoutProgress = options.onCheckoutProgress
    ? createWorktreeCheckoutProgressReader(options.onCheckoutProgress)
    : null
  try {
    const [checkoutWorkersArgs] = await Promise.all([
      checkoutWorkersGitArgs(worktreePath, options),
      cloneMainCheckoutIntoWorktree(method, repoPath, worktreePath, 'HEAD', options)
    ])
    // A checkout, not reset, so post-checkout hooks still run as they do for `worktree add`.
    await gitExecFileAsync(
      [...checkoutWorkersArgs, ...windowsLongPathGitArgs(worktreePath), 'checkout', '-f'],
      {
        ...gitExecOptions(worktreePath, options),
        timeout: resolveWorktreeAddTimeoutMs(),
        ...(checkoutProgress ? { onStderr: checkoutProgress.read } : {})
      }
    )
    return addResult
  } catch (error) {
    throw await rollBackCreatedWorktree(repoPath, worktreePath, branch, options, error)
  } finally {
    checkoutProgress?.close()
  }
}
