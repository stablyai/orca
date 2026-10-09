import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../shared/git-diff-compare-types'
import { assertGitDiffWithinTransportBudget } from '../../shared/git-diff-transport-budget'
import { getBranchDiff } from '../git/status'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import { normalizeRuntimeRelativePath } from './runtime-relative-paths'
import {
  localGitOptionsForTarget,
  normalizeRuntimeGitRelativePath,
  requireRuntimeGitProvider,
  requireSshRuntimeGitProvider,
  runtimeGitRouteForTarget,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'

export class RuntimeGitDiffCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  // Why: cap both local and forwarded SSH payloads after execution-host dispatch.
  async getRuntimeGitDiff(
    worktreeSelector: string,
    filePath: string,
    staged: boolean,
    compareAgainstHead?: boolean,
    maxContentBytes?: number
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    return assertGitDiffWithinTransportBudget(
      await requireRuntimeGitProvider(target).getDiff(
        target.worktree.path,
        relativePath,
        staged,
        compareAgainstHead
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
    worktreeSelector: string,
    compare: { mergeBase: string; headOid: string },
    filePath: string,
    oldPath?: string,
    maxContentBytes?: number
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const oldRelativePath = oldPath ? normalizeRuntimeGitRelativePath(oldPath) : undefined
    const route = runtimeGitRouteForTarget(target)
    if (route.kind === 'ssh') {
      const provider = requireSshRuntimeGitProvider(route)
      const results = await provider.getBranchDiff(target.worktree.path, compare.mergeBase, {
        includePatch: true,
        headOid: compare.headOid,
        filePath: relativePath,
        oldPath: oldRelativePath
      })
      return assertGitDiffWithinTransportBudget(
        results[0] ?? {
          kind: 'text',
          originalContent: '',
          modifiedContent: '',
          originalIsBinary: false,
          modifiedIsBinary: false
        },
        maxContentBytes
      )
    }
    return assertGitDiffWithinTransportBudget(
      await getBranchDiff(
        target.worktree.path,
        {
          mergeBase: compare.mergeBase,
          headOid: compare.headOid,
          filePath: relativePath,
          oldPath: oldRelativePath
        },
        {
          ...localGitOptionsForTarget(target),
          admissionTier: 'interactive'
        }
      ),
      maxContentBytes
    )
  }

  async getRuntimeGitCommitDiff(
    worktreeSelector: string,
    args: { commitOid: string; parentOid?: string | null; filePath: string; oldPath?: string },
    maxContentBytes?: number
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeRelativePath(args.filePath)
    const oldRelativePath = args.oldPath ? normalizeRuntimeRelativePath(args.oldPath) : undefined
    return assertGitDiffWithinTransportBudget(
      await requireRuntimeGitProvider(target).getCommitDiff(target.worktree.path, {
        commitOid: args.commitOid,
        parentOid: args.parentOid,
        filePath: relativePath,
        oldPath: oldRelativePath
      }),
      maxContentBytes
    )
  }

  async getRuntimeGitRemoteFileUrl(
    worktreeSelector: string,
    relativePath: string,
    line: number
  ): Promise<string | null> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const normalizedRelativePath = normalizeRuntimeGitRelativePath(relativePath)
    return requireRuntimeGitProvider(target).getRemoteFileUrl(
      target.worktree.path,
      normalizedRelativePath,
      line
    )
  }

  async getRuntimeGitRemoteCommitUrl(
    worktreeSelector: string,
    sha: string
  ): Promise<string | null> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).getRemoteCommitUrl(target.worktree.path, sha)
  }
}
