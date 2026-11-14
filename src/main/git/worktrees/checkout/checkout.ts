import { snapshotLocalBranchMetadata } from '../../refs/snapshot/branch-ref-snapshot'
import type { RuntimeGitLocalBranches } from '../../../../shared/runtime-worktree-contracts'
import type { BranchSwitchCreation } from '../../../../shared/git/branch-switch-target'

import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitEnvWithoutYesNoPrompt } from '../../command-runner/git-environment/git-no-prompt-env'
import { parseCheckoutSkippedPaths } from './checkout-skipped-paths'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'

/** Reject empty and option-like names here too: relay callers can bypass RPC schema validation. */
export function assertValidBranchName(branch: string): void {
  if (branch.length === 0 || branch.startsWith('-')) {
    throw new Error('invalid_branch_name')
  }
}

/** Leave conflicting changes to Git; trailing -- disambiguates the branch from pathspecs. */
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
  options: GitRuntimeOptions & { detached?: boolean } = {},
  creation?: BranchSwitchCreation
): Promise<{ skippedPaths: string[] }> {
  assertValidBranchName(branch)
  const args =
    creation?.kind === 'new'
      ? ['checkout', '--no-track', '-b', branch, '--']
      : creation?.kind === 'remote'
        ? ['checkout', '--track', '-b', branch, creation.startPoint, '--']
        : ['checkout', ...(options.detached ? ['--detach', `${branch}^{commit}`] : [branch]), '--']
  const { stderr } = await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(args, {
      ...gitOptionsForWorktree(worktreePath, options),
      // A locked file must fail the checkout, not open a prompt while the switch lock is held.
      ...gitEnvWithoutYesNoPrompt()
    })
  )
  return { skippedPaths: parseCheckoutSkippedPaths(stderr) }
}

/** Current checkout state stays request-specific while the shared branch population is reused. */
export async function listLocalBranches(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<RuntimeGitLocalBranches> {
  options.signal?.throwIfAborted()
  const {
    refs,
    current,
    worktreePaths: occupied
  } = await snapshotLocalBranchMetadata(worktreePath, options)
  options.signal?.throwIfAborted()
  const branches = refs.map((ref) => ref.label)
  if (current) {
    const index = branches.indexOf(current)
    if (index !== -1) {
      branches.splice(index, 1)
    }
    branches.unshift(current)
  }
  const committedAt: Record<string, number> = Object.create(null)
  const worktreePaths: Record<string, string> = Object.create(null)
  for (const ref of refs) {
    committedAt[ref.label] = ref.committedAt
  }
  for (const [name, path] of occupied) {
    worktreePaths[name] = path
  }
  return { current, branches, committedAt, worktreePaths }
}
