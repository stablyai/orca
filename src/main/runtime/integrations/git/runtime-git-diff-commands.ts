import type { RpcParams } from '../../../../shared/rpc-contract/rpc-params-catalog.generated'
import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../../../shared/git/diff/git-diff-compare-types'
import type { GitBlameResult } from '../../../../shared/git/blame/git-blame-types'
import { assertGitDiffWithinTransportBudget } from '../../../../shared/git/diff/git-diff-transport-budget'
import { getBranchDiff } from '../../../git/source-control/comparisons/branch-diff'
import type { GitAdmissionTier } from '../../../../shared/rpc-contract/source-control/git-admission-tier-params'
import { normalizeRuntimeRelativePath } from '../../files/paths/runtime-relative-paths'
import {
  localGitOptionsForTarget,
  normalizeRuntimeGitRelativePath,
  requireLocalRuntimeGitRoute,
  requireRuntimeGitProvider,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'

export class RuntimeGitDiffCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  // Why: cap the payload after execution-host dispatch.
  async getRuntimeGitDiff(
    args: RpcParams<'git.diff'>,
    maxContentBytes?: number
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(args.worktree)
    const relativePath = normalizeRuntimeGitRelativePath(args.filePath)
    const oldRelativePath = args.oldPath ? normalizeRuntimeGitRelativePath(args.oldPath) : undefined
    return assertGitDiffWithinTransportBudget(
      await requireRuntimeGitProvider(target).getDiff(
        target.worktree.path,
        relativePath,
        args.staged,
        args.compareAgainstHead,
        oldRelativePath,
        args.encoding
      ),
      maxContentBytes
    )
  }

  async getRuntimeGitBranchCompare(
    worktreeSelector: string,
    baseRef: string,
    admissionTier: GitAdmissionTier = 'interactive'
  ): Promise<GitBranchCompareResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).getBranchCompare(target.worktree.path, baseRef, {
      admissionTier
    })
  }

  async getRuntimeGitCommitCompare(
    worktreeSelector: string,
    commitId: string
  ): Promise<GitCommitCompareResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).getCommitCompare(target.worktree.path, commitId)
  }

  async getRuntimeGitBranchDiff(
    args: RpcParams<'git.branchDiff'>,
    maxContentBytes?: number
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(args.worktree)
    const relativePath = normalizeRuntimeGitRelativePath(args.filePath)
    const oldRelativePath = args.oldPath ? normalizeRuntimeGitRelativePath(args.oldPath) : undefined
    requireLocalRuntimeGitRoute(target)
    return assertGitDiffWithinTransportBudget(
      await getBranchDiff(
        target.worktree.path,
        {
          mergeBase: args.compare.mergeBase,
          headOid: args.compare.headOid,
          filePath: relativePath,
          oldPath: oldRelativePath
        },
        {
          ...localGitOptionsForTarget(target),
          admissionTier: 'interactive',
          encoding: args.encoding
        }
      ),
      maxContentBytes
    )
  }

  async getRuntimeGitCommitDiff(
    args: RpcParams<'git.commitDiff'>,
    maxContentBytes?: number
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(args.worktree)
    const relativePath = normalizeRuntimeRelativePath(args.filePath)
    const oldRelativePath = args.oldPath ? normalizeRuntimeRelativePath(args.oldPath) : undefined
    return assertGitDiffWithinTransportBudget(
      await requireRuntimeGitProvider(target).getCommitDiff(
        target.worktree.path,
        {
          commitOid: args.commitOid,
          parentOid: args.parentOid,
          filePath: relativePath,
          oldPath: oldRelativePath
        },
        args.encoding
      ),
      maxContentBytes
    )
  }

  async getRuntimeGitRemoteFileUrl(
    worktreeSelector: string,
    relativePath: string,
    line: number,
    endLine?: number
  ): Promise<string | null> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const normalizedRelativePath = normalizeRuntimeGitRelativePath(relativePath)
    return requireRuntimeGitProvider(target).getRemoteFileUrl(
      target.worktree.path,
      normalizedRelativePath,
      line,
      endLine
    )
  }

  async getRuntimeGitRemoteCommitUrl(
    worktreeSelector: string,
    sha: string
  ): Promise<string | null> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).getRemoteCommitUrl(target.worktree.path, sha)
  }

  async getRuntimeGitBlame(
    worktreeSelector: string,
    filePath: string,
    knownHeadOid?: string
  ): Promise<GitBlameResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).getBlame(
      target.worktree.path,
      normalizeRuntimeGitRelativePath(filePath),
      knownHeadOid
    )
  }
}
