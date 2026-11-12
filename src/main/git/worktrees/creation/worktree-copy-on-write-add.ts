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

/** `git hook run` (Git 2.36+), which runs post-checkout with the arguments `worktree add` uses. */
function supportsHookRun(repoPath: string, options: AddWorktreeOptions): Promise<boolean> {
  return gitExecFileAsync(
    ['hook', 'run', '--ignore-missing', 'orca-hook-run-probe'],
    gitExecOptions(repoPath, options)
  ).then(
    () => true,
    () => false
  )
}

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
  const [method, canRunHooks] = await Promise.all([
    resolveCopyOnWriteCheckout(repoPath, worktreePath, options),
    supportsHookRun(repoPath, options)
  ])
  if (!method || !canRunHooks) {
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
    // Materialize and run post-checkout exactly as `worktree add` does: a reset that leaves
    // submodules unpopulated, then the hook with a null previous HEAD to mark a new checkout.
    await gitExecFileAsync(
      [
        ...checkoutWorkersArgs,
        ...windowsLongPathGitArgs(worktreePath),
        'reset',
        '--hard',
        '--no-recurse-submodules'
      ],
      {
        ...gitExecOptions(worktreePath, options),
        timeout: resolveWorktreeAddTimeoutMs(),
        ...(checkoutProgress ? { onStderr: checkoutProgress.read } : {})
      }
    )
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', 'HEAD'],
      gitExecOptions(worktreePath, options)
    )
    const head = stdout.trim()
    await gitExecFileAsync(
      [
        'hook',
        'run',
        '--ignore-missing',
        'post-checkout',
        '--',
        '0'.repeat(head.length),
        head,
        '1'
      ],
      { ...gitExecOptions(worktreePath, options), timeout: resolveWorktreeAddTimeoutMs() }
    )
    return addResult
  } catch (error) {
    throw await rollBackCreatedWorktree(repoPath, worktreePath, branch, options, error)
  } finally {
    checkoutProgress?.close()
  }
}
