import { getStoredRepoExecutionHostId } from '../repo-execution-host'
import type { BranchPrefixStrategy } from '../../shared/ui-chrome-types'
import type { Repo } from '../../shared/repo-types'
import { getPRForBranch } from '../github/client'
import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import { gitExecFileAsync } from '../git/runner'
import { foldGitRefNameCase } from '../git/repo-branch-conflict'
import { listWorktrees } from '../git/worktree'
import { computeValidatedBranchName } from '../ipc/worktree-branch-name'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import {
  getSelectedReviewBranch,
  getSelectedReviewLookupHints,
  type SelectedReviewBranchInput
} from './selected-review-branch'
import { hasLocalGitOptions, normalizeLocalBranchName } from './runtime-worktree-selection'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'

export async function resolveCreateBranchName(
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  username: string | null,
  gitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {}
): Promise<string> {
  if (!branchNameOverride) {
    return computeValidatedBranchName(
      sanitizedName,
      { ...settings, branchPrefix: settings.branchPrefix as BranchPrefixStrategy },
      username
    )
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await gitExecFileAsync(['check-ref-format', '--branch', branchNameOverride], {
    cwd: repoPath,
    ...gitOptions
  })
  return branchNameOverride
}

export async function canCheckoutExistingLocalBranch(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  gitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {},
  explicitReuse = false
): Promise<boolean> {
  let localHead = ''
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      { cwd: repoPath, ...gitOptions }
    )
    localHead = stdout.trim()
  } catch (error) {
    if (explicitReuse && !(error instanceof Error && 'code' in error && error.code === 1)) {
      throw error
    }
    return false
  }
  if (explicitReuse && !localHead) {
    return false
  }
  const hasExactBranchRef = async (name: string): Promise<boolean> => {
    // Loose refs can resolve aliases on case-insensitive filesystems; require Git's stored spelling.
    const ref = `refs/heads/${name}`
    const { stdout } = await gitExecFileAsync(['for-each-ref', '--format=%(refname)', ref], {
      cwd: repoPath,
      ...gitOptions,
      captureWslLoginShellOutput: true
    })
    return stdout.split(/\r?\n/).includes(ref)
  }
  if (explicitReuse && !(await hasExactBranchRef(branchName))) {
    throw new Error(
      `Branch "${branchName}" resolves to a differently named ref. Select its exact branch name, or turn off Reuse branch.`
    )
  }
  if (!explicitReuse && normalizeLocalBranchName(baseBranch) !== branchName) {
    if (!localHead) {
      return false
    }
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`],
        { cwd: repoPath, ...gitOptions }
      )
      if (stdout.trim() !== localHead) {
        return false
      }
    } catch {
      return false
    }
  }
  const worktrees = await listWorktrees(repoPath, gitOptions)
  let busy = worktrees.find((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
  if (explicitReuse && !busy) {
    for (const worktree of worktrees) {
      const checkedOutBranch = normalizeLocalBranchName(worktree.branch)
      if (
        foldGitRefNameCase(checkedOutBranch) === foldGitRefNameCase(branchName) &&
        !(await hasExactBranchRef(checkedOutBranch))
      ) {
        busy = worktree
        break
      }
    }
  }
  if (explicitReuse && busy) {
    throw new Error(
      `Branch "${branchName}" is already checked out at "${busy.path}". Open that workspace, or turn off Reuse branch to create a separate branch.`
    )
  }
  return !busy
}

export function getLocalGitHubPrForBranch(
  repoPath: string,
  branchName: string,
  gitOptions: { wslDistro?: string }
): ReturnType<typeof getPRForBranch> {
  return hasLocalGitOptions(gitOptions)
    ? getPRForBranch(repoPath, branchName, null, null, null, {
        localGitExecOptions: gitOptions
      })
    : getPRForBranch(repoPath, branchName)
}

export async function getSelectedHostedReviewForBranch(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>,
  branchName: string,
  args: SelectedReviewBranchInput,
  executionOptions: HostedReviewExecutionOptions = {}
): Promise<{ matchesSelected: boolean; number: number } | null> {
  const selectedReview = getSelectedReviewBranch(args)
  if (!selectedReview) {
    return null
  }
  const review = await getHostedReviewForBranch({
    repoPath: repo.path,
    executionHostId: getStoredRepoExecutionHostId(repo),
    branch: branchName,
    ...executionOptions,
    ...getSelectedReviewLookupHints(args)
  })
  return review
    ? {
        matchesSelected:
          review.provider === selectedReview.provider && review.number === selectedReview.number,
        number: review.number
      }
    : null
}
