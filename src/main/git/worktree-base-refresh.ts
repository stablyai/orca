import type { LocalBaseRefRefreshResult } from '../../shared/worktree/base-ref-drift-types'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import {
  evaluateLocalBaseRefRefreshability,
  getLocalBaseRefUpdateSuggestionForWorktreeCreate
} from './worktree-base-refresh-analysis'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import type { AddWorktreeOptions, GitWorktreeExecOptions } from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'

export { getLocalBaseRefUpdateSuggestionForWorktreeCreate }

export async function refreshLocalBaseRefForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefRefreshResult | undefined> {
  const evaluation = await evaluateLocalBaseRefRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase,
    options
  )
  if (!evaluation) {
    return undefined
  }
  if (!evaluation.refreshable) {
    return evaluation.result
  }

  const resultBase = { baseRef: evaluation.baseRef, localBranch: evaluation.localBranch }
  try {
    if (evaluation.ownerWorktreePath) {
      const { stdout: worktreeListOutput } = await gitExecFileAsync(
        ['worktree', 'list', '--porcelain'],
        gitExecOptions(repoPath, options)
      )
      const worktrees = parseWorktreeList(
        translateWslOutputPaths(worktreeListOutput, repoPath, options)
      )
      const currentOwner = worktrees.find((wt) => wt.branch === evaluation.fullRef)
      if (!currentOwner || currentOwner.path !== evaluation.ownerWorktreePath) {
        return { ...resultBase, status: 'skipped_error' }
      }
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        gitExecOptions(currentOwner.path, options)
      )
      if (status.trim()) {
        return {
          ...resultBase,
          status: 'skipped_dirty_worktree',
          ownerWorktreePath: currentOwner.path
        }
      }
      await gitExecFileAsync(
        ['reset', '--hard', evaluation.remoteOid],
        gitExecOptions(currentOwner.path, options)
      )
      return { ...resultBase, status: 'updated', ownerWorktreePath: currentOwner.path }
    }

    // Why: no owner worktree — fast-forward the bare ref; the expected-old-OID form is a no-op-safe CAS if the ref moved since evaluation.
    await gitExecFileAsync(
      ['update-ref', evaluation.fullRef, evaluation.remoteOid, evaluation.localOid],
      gitExecOptions(repoPath, options)
    )
    return { ...resultBase, status: 'updated' }
  } catch {
    // update-ref/reset can fail on locked refs or odd worktree states; worktree creation should still proceed.
    return { ...resultBase, status: 'skipped_error' }
  }
}
