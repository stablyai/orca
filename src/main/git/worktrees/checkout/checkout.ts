import type { RuntimeGitLocalBranches } from '../../../../shared/runtime-worktree-contracts'
import type { BranchSwitchCreation } from '../../../../shared/git/branch-switch-target'

import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitEnvWithoutYesNoPrompt } from '../../command-runner/git-environment/git-no-prompt-env'
import { translateWorktreePath } from '../catalog/worktree-path-comparison'
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

/** for-each-ref avoids localized branch decoration; return the current branch first. */
export async function listLocalBranches(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<RuntimeGitLocalBranches> {
  const execution = gitOptionsForWorktree(worktreePath, options)
  let extended = true
  const { stdout } = await gitExecFileAsync(
    [
      'for-each-ref',
      '--format=%(HEAD)%09%(refname:lstrip=2)%09%(committerdate:unix)%09%(worktreepath)',
      'refs/heads/'
    ],
    execution
  ).catch((error) => {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
    extended = false
    return gitExecFileAsync(
      ['for-each-ref', '--format=%(HEAD)%09%(refname:lstrip=2)', 'refs/heads/'],
      execution
    )
  })
  let current: string | null = null
  const branches: string[] = []
  const committedAt: Record<string, number> = Object.create(null)
  const worktreePaths: Record<string, string> = Object.create(null)
  for (const line of stdout.split('\n')) {
    if (line.length === 0) {
      continue
    }
    const [marker, name, timestamp, occupiedPath] = line.split('\t')
    if (!name) {
      continue
    }
    if (marker === '*') {
      current = name
    }
    branches.push(name)
    if (timestamp && Number.isFinite(Number(timestamp))) {
      committedAt[name] = Number(timestamp) * 1000
    }
    if (occupiedPath) {
      worktreePaths[name] = translateWorktreePath(occupiedPath, worktreePath, options)
    }
  }
  branches.sort((a, b) => {
    if (a === current) {
      return -1
    }
    if (b === current) {
      return 1
    }
    return 0
  })
  return { current, branches, ...(extended ? { committedAt, worktreePaths } : {}) }
}
