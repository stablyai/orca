import type { RequestContext } from './dispatcher'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { branchCompare as branchCompareOp } from './git-handler-ops'
import { commitCompare as commitCompareOp } from './git-handler-commit-diff-ops'
import { gitChangeListArgs, parseGitChangeList } from '../shared/git-change-list'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../shared/git-remote-error'
import { upstreamOnlyCommitsArePatchEquivalent } from '../shared/git-upstream-status'
import { assertValidGitPushTarget } from '../shared/git-push-target-validation'
import { getPublishTargetStatus } from '../shared/git-publish-target-status'
import { getEffectiveGitUpstreamStatus } from '../shared/git-effective-upstream'

export class GitHandlerComparisonOperations extends GitHandlerOperationContext {
  async branchCompare(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    // Why: reject flag-like base refs to prevent rev-parse option injection.
    if (baseRef.startsWith('-')) {
      throw new Error('Base ref must not start with "-"')
    }
    const gitBound = this.gitForSignal(context?.signal)
    const result = await branchCompareOp(
      gitBound,
      worktreePath,
      baseRef,
      async (mergeBase, headOid) => {
        const { stdout } = await gitBound(gitChangeListArgs(mergeBase, headOid), worktreePath)
        return parseGitChangeList(stdout)
      }
    )
    context?.signal?.throwIfAborted()
    return result
  }

  async commitCompare(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const commitId = params.commitId as string
    const result = await commitCompareOp(this.gitForSignal(context?.signal), worktreePath, commitId)
    context?.signal?.throwIfAborted()
    return result
  }

  async upstreamStatus(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const git = this.gitForSignal(context?.signal)

    try {
      if (params.pushTarget !== undefined) {
        assertValidGitPushTarget(params.pushTarget)
        const pushTarget = params.pushTarget
        await git(['check-ref-format', '--branch', pushTarget.branchName], worktreePath)
        return await getPublishTargetStatus(
          (args) => git(args, worktreePath),
          pushTarget,
          (upstreamName) =>
            this.getBehindCommitsArePatchEquivalent(worktreePath, upstreamName, context?.signal)
        )
      }
      return await getEffectiveGitUpstreamStatus(
        (args) => git(args, worktreePath),
        (upstreamName) =>
          this.getBehindCommitsArePatchEquivalent(worktreePath, upstreamName, context?.signal)
      )
    } catch (error) {
      context?.signal?.throwIfAborted()
      // Why: suppress only the expected no-upstream error; surface all others.
      if (isNoUpstreamError(error)) {
        return { hasUpstream: false, ahead: 0, behind: 0 }
      }
      // Why: match fetch/push/pull normalization so execFile preamble and local paths don't leak to the renderer.
      throw new Error(normalizeGitErrorMessage(error, 'upstream'))
    } finally {
      context?.signal?.throwIfAborted()
    }
  }

  private async getBehindCommitsArePatchEquivalent(
    worktreePath: string,
    upstreamName: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const { stdout } = await this.gitForSignal(signal)(
        [
          'log',
          '--no-show-signature',
          '--no-color',
          '--oneline',
          '--cherry-mark',
          '--right-only',
          `HEAD...${upstreamName}`,
          '--'
        ],
        worktreePath
      )
      return upstreamOnlyCommitsArePatchEquivalent(stdout)
    } catch {
      // Why: this only identifies stale post-rebase upstreams; if the probe fails over SSH, keep the conservative pull-first sync path.
      return false
    }
  }
}
