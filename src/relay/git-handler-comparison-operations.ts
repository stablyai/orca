import { GitHandlerOperationContext } from './git-handler-operation-context'
import { branchCompare as branchCompareOp } from './git-handler-ops'
import { commitCompare as commitCompareOp } from './git-handler-commit-diff-ops'
import { parseBranchDiff } from './git-handler-utils'
import { parseNumstat } from '../shared/git-uncommitted-line-stats'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../shared/git-remote-error'
import { upstreamOnlyCommitsArePatchEquivalent } from '../shared/git-upstream-status'
import { assertGitPushTargetShape } from '../shared/git-push-target-validation'
import { getPublishTargetStatus, type GitCommandRunner } from '../shared/git-publish-target-status'
import type { GitPushTarget } from '../shared/worktree/types'
import { getEffectiveGitUpstreamStatus } from '../shared/git-effective-upstream'

export class GitHandlerComparisonOperations extends GitHandlerOperationContext {
  async branchCompare(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    // Why: reject flag-like base refs to prevent rev-parse option injection.
    if (baseRef.startsWith('-')) {
      throw new Error('Base ref must not start with "-"')
    }
    const gitBound = this.git.bind(this)
    return branchCompareOp(gitBound, worktreePath, baseRef, async (mergeBase, headOid) => {
      // Why: preserve non-ASCII filenames as UTF-8 for parseBranchDiff.
      const [{ stdout }, { stdout: numstat }] = await Promise.all([
        gitBound(
          ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', mergeBase, headOid],
          worktreePath
        ),
        gitBound(
          ['-c', 'core.quotePath=false', 'diff', '--numstat', '-M', '-C', mergeBase, headOid],
          worktreePath
        )
      ])
      return parseBranchDiff(stdout, parseNumstat(numstat))
    })
  }

  async commitCompare(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const commitId = params.commitId as string
    return commitCompareOp(this.git.bind(this), worktreePath, commitId)
  }

  async upstreamStatus(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string

    try {
      if (params.pushTarget !== undefined) {
        assertGitPushTargetShape(params.pushTarget)
        const pushTarget = params.pushTarget as GitPushTarget
        await this.git(['check-ref-format', '--branch', pushTarget.branchName], worktreePath)
        return await getPublishTargetStatus(
          ((args) => this.git(args, worktreePath)) as GitCommandRunner,
          pushTarget,
          (upstreamName) => this.getBehindCommitsArePatchEquivalent(worktreePath, upstreamName)
        )
      }
      return await getEffectiveGitUpstreamStatus(
        (args) => this.git(args, worktreePath),
        (upstreamName) => this.getBehindCommitsArePatchEquivalent(worktreePath, upstreamName)
      )
    } catch (error) {
      // Why: suppress only the expected no-upstream error; surface all others.
      if (isNoUpstreamError(error)) {
        return { hasUpstream: false, ahead: 0, behind: 0 }
      }
      // Why: match fetch/push/pull normalization so execFile preamble and local paths don't leak to the renderer.
      throw new Error(normalizeGitErrorMessage(error, 'upstream'))
    }
  }

  private async getBehindCommitsArePatchEquivalent(
    worktreePath: string,
    upstreamName: string
  ): Promise<boolean> {
    try {
      const { stdout } = await this.git(
        ['log', '--oneline', '--cherry-mark', '--right-only', `HEAD...${upstreamName}`, '--'],
        worktreePath
      )
      return upstreamOnlyCommitsArePatchEquivalent(stdout)
    } catch {
      // Why: this only identifies stale post-rebase upstreams; if the probe fails over SSH, keep the conservative pull-first sync path.
      return false
    }
  }
}
