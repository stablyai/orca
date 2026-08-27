import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../shared/git-diff-compare-types'
import { assertGitDiffWithinTransportBudget } from '../../shared/git-diff-transport-budget'
import { getRemoteCommitUrl, getRemoteFileUrl } from '../git/repo'
import {
  getBranchCompare,
  getBranchDiff,
  getCommitCompare,
  getCommitDiff,
  getDiff
} from '../git/status'
import { awaitWindowsHostGitEnvironmentReady } from '../git/runner'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { normalizeRuntimeRelativePath } from './runtime-relative-paths'
import {
  localGitOptionsForTarget,
  normalizeRuntimeGitRelativePath,
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
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return assertGitDiffWithinTransportBudget(
        await provider.getDiff(target.worktree.path, relativePath, staged, compareAgainstHead),
        maxContentBytes
      )
    }
    return assertGitDiffWithinTransportBudget(
      await getDiff(
        target.worktree.path,
        relativePath,
        staged,
        compareAgainstHead,
        localGitOptionsForTarget(target)
      ),
      maxContentBytes
    )
  }

  async getRuntimeGitBranchCompare(
    worktreeSelector: string,
    baseRef: string
  ): Promise<GitBranchCompareResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getBranchCompare(target.worktree.path, baseRef)
    }
    return getBranchCompare(target.worktree.path, baseRef, localGitOptionsForTarget(target))
  }

  async getRuntimeGitCommitCompare(
    worktreeSelector: string,
    commitId: string
  ): Promise<GitCommitCompareResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getCommitCompare(target.worktree.path, commitId)
    }
    return getCommitCompare(target.worktree.path, commitId, localGitOptionsForTarget(target))
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
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
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
        localGitOptionsForTarget(target)
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
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return assertGitDiffWithinTransportBudget(
        await provider.getCommitDiff(target.worktree.path, {
          commitOid: args.commitOid,
          parentOid: args.parentOid,
          filePath: relativePath,
          oldPath: oldRelativePath
        }),
        maxContentBytes
      )
    }
    return assertGitDiffWithinTransportBudget(
      await getCommitDiff(
        target.worktree.path,
        {
          commitOid: args.commitOid,
          parentOid: args.parentOid,
          filePath: relativePath,
          oldPath: oldRelativePath
        },
        localGitOptionsForTarget(target)
      ),
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
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getRemoteFileUrl(target.worktree.path, normalizedRelativePath, line)
    }
    await awaitWindowsHostGitEnvironmentReady({ cwd: target.worktree.path })
    return getRemoteFileUrl(target.worktree.path, normalizedRelativePath, line)
  }

  async getRuntimeGitRemoteCommitUrl(
    worktreeSelector: string,
    sha: string
  ): Promise<string | null> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getRemoteCommitUrl(target.worktree.path, sha)
    }
    await awaitWindowsHostGitEnvironmentReady({ cwd: target.worktree.path })
    return getRemoteCommitUrl(target.worktree.path, sha)
  }
}
