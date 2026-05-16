/* eslint-disable max-lines -- Why: runtime git dispatch stays in one boundary so local, SSH, and runtime-environment behavior remains comparable. */
import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitPushTarget,
  GitStatusResult,
  GitUpstreamStatus,
  GitWorktreeInfo,
  GlobalSettings,
  Worktree
} from '../../shared/types'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import { getRemoteFileUrl } from '../git/repo'
import {
  bulkDiscardChanges,
  bulkStageFiles,
  bulkUnstageFiles,
  commitChanges,
  detectConflictOperation,
  discardChanges,
  getBranchCompare,
  getBranchDiff,
  getCommitCompare,
  getCommitDiff,
  getDiff,
  getStagedCommitContext,
  getStatus as getGitStatus,
  stageFile,
  unstageFile
} from '../git/status'
import { getHistory as getGitHistory } from '../git/history'
import { getUpstreamStatus } from '../git/upstream'
import { gitFetch, gitPull, gitPush } from '../git/remote'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  cancelGenerateCommitMessageLocal,
  generateCommitMessageFromContext,
  resolveCommitMessageSettings,
  type GenerateCommitMessageResult
} from '../text-generation/commit-message-text-generation'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import { normalizeRuntimeRelativePath } from './runtime-relative-paths'

export type ResolvedRuntimeGitWorktree = Worktree & { git: GitWorktreeInfo }
type RuntimeCommitMessageSettingsOverride = Partial<
  Pick<GlobalSettings, 'commitMessageAi' | 'agentCmdOverrides' | 'enableGitHubAttribution'>
>

function normalizeRuntimeGitRelativePath(filePath: string): string {
  const relativePath = normalizeRuntimeRelativePath(filePath)
  if (relativePath === '') {
    // Why: git mutation APIs treat an empty pathspec as the worktree root;
    // runtime RPC must never let malformed file paths discard whole worktrees.
    throw new Error('invalid_relative_path')
  }
  return relativePath
}

export type RuntimeGitCommandHost = {
  resolveRuntimeGitTarget(
    selector: string
  ): Promise<{ worktree: ResolvedRuntimeGitWorktree; connectionId?: string }>
  getRuntimeSettings(): GlobalSettings
  getCommitMessageAgentEnvironment?(): CommitMessageAgentEnvironmentResolvers | undefined
}

export class RuntimeGitCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async getRuntimeGitStatus(
    worktreeSelector: string,
    options?: { includeIgnored?: boolean }
  ): Promise<GitStatusResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return options
        ? provider.getStatus(target.worktree.path, options)
        : provider.getStatus(target.worktree.path)
    }
    return options
      ? getGitStatus(target.worktree.path, options)
      : getGitStatus(target.worktree.path)
  }

  async getRuntimeGitHistory(
    worktreeSelector: string,
    options: GitHistoryOptions = {}
  ): Promise<GitHistoryResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return provider.getHistory(target.worktree.path, options)
    }
    return getGitHistory(target.worktree.path, options)
  }

  async getRuntimeGitConflictOperation(worktreeSelector: string): Promise<GitConflictOperation> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return provider.detectConflictOperation(target.worktree.path)
    }
    return detectConflictOperation(target.worktree.path)
  }

  async getRuntimeGitDiff(
    worktreeSelector: string,
    filePath: string,
    staged: boolean,
    compareAgainstHead?: boolean
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return provider.getDiff(target.worktree.path, relativePath, staged, compareAgainstHead)
    }
    return getDiff(target.worktree.path, relativePath, staged, compareAgainstHead)
  }

  async getRuntimeGitBranchCompare(
    worktreeSelector: string,
    baseRef: string
  ): Promise<GitBranchCompareResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return provider.getBranchCompare(target.worktree.path, baseRef)
    }
    return getBranchCompare(target.worktree.path, baseRef)
  }

  async getRuntimeGitCommitCompare(
    worktreeSelector: string,
    commitId: string
  ): Promise<GitCommitCompareResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return provider.getCommitCompare(target.worktree.path, commitId)
    }
    return getCommitCompare(target.worktree.path, commitId)
  }

  async getRuntimeGitUpstreamStatus(worktreeSelector: string): Promise<GitUpstreamStatus> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return provider.getUpstreamStatus(target.worktree.path)
    }
    return getUpstreamStatus(target.worktree.path)
  }

  async fetchRuntimeGit(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.fetchRemote(target.worktree.path)
      return { ok: true }
    }
    await gitFetch(target.worktree.path)
    return { ok: true }
  }

  async pullRuntimeGit(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.pullBranch(target.worktree.path)
      return { ok: true }
    }
    await gitPull(target.worktree.path)
    return { ok: true }
  }

  async pushRuntimeGit(
    worktreeSelector: string,
    publish?: boolean,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.pushBranch(target.worktree.path, publish === true, pushTarget)
      return { ok: true }
    }
    await gitPush(target.worktree.path, publish === true, pushTarget)
    return { ok: true }
  }

  async getRuntimeGitBranchDiff(
    worktreeSelector: string,
    compare: { mergeBase: string; headOid: string },
    filePath: string,
    oldPath?: string
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const oldRelativePath = oldPath ? normalizeRuntimeGitRelativePath(oldPath) : undefined
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      const results = await provider.getBranchDiff(target.worktree.path, compare.mergeBase, {
        includePatch: true,
        filePath: relativePath,
        oldPath: oldRelativePath
      })
      return (
        results[0] ?? {
          kind: 'text',
          originalContent: '',
          modifiedContent: '',
          originalIsBinary: false,
          modifiedIsBinary: false
        }
      )
    }
    return getBranchDiff(target.worktree.path, {
      mergeBase: compare.mergeBase,
      headOid: compare.headOid,
      filePath: relativePath,
      oldPath: oldRelativePath
    })
  }

  async getRuntimeGitCommitDiff(
    worktreeSelector: string,
    args: { commitOid: string; parentOid?: string | null; filePath: string; oldPath?: string }
  ): Promise<GitDiffResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeRelativePath(args.filePath)
    const oldRelativePath = args.oldPath ? normalizeRuntimeRelativePath(args.oldPath) : undefined
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return provider.getCommitDiff(target.worktree.path, {
        commitOid: args.commitOid,
        parentOid: args.parentOid,
        filePath: relativePath,
        oldPath: oldRelativePath
      })
    }
    return getCommitDiff(target.worktree.path, {
      commitOid: args.commitOid,
      parentOid: args.parentOid,
      filePath: relativePath,
      oldPath: oldRelativePath
    })
  }

  async commitRuntimeGit(
    worktreeSelector: string,
    message: string
  ): Promise<{ success: boolean; error?: string }> {
    if (message.trim().length === 0) {
      throw new Error('Commit message is required')
    }
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      return provider.commit(target.worktree.path, message)
    }
    return commitChanges(target.worktree.path, message)
  }

  async generateRuntimeCommitMessage(
    worktreeSelector: string,
    settingsOverride?: RuntimeCommitMessageSettingsOverride
  ): Promise<GenerateCommitMessageResult> {
    const resolvedSettings = resolveCommitMessageSettings({
      ...this.host.getRuntimeSettings(),
      ...settingsOverride
    })
    if (!resolvedSettings.ok) {
      return { success: false, error: resolvedSettings.error }
    }

    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        return {
          success: false,
          error: `No git provider for connection "${target.connectionId}"`
        }
      }
      let context: CommitMessageDraftContext | null
      try {
        context = await provider.getStagedCommitContext(target.worktree.path)
      } catch (error) {
        console.error('[runtime-git] Failed to read remote staged commit context:', error)
        return { success: false, error: 'Failed to read staged changes.' }
      }
      if (!context) {
        return { success: false, error: 'No staged changes to summarize.' }
      }
      return generateCommitMessageFromContext(context, resolvedSettings.params, {
        kind: 'remote',
        cwd: target.worktree.path,
        execute: (plan, cwd, timeoutMs) => provider.executeCommitMessagePlan(plan, cwd, timeoutMs),
        missingBinaryLocation: 'remote PATH'
      })
    }

    let context: CommitMessageDraftContext | null
    try {
      context = await getStagedCommitContext(target.worktree.path)
    } catch (error) {
      console.error('[runtime-git] Failed to read staged commit context:', error)
      return { success: false, error: 'Failed to read staged changes.' }
    }
    if (!context) {
      return { success: false, error: 'No staged changes to summarize.' }
    }
    const localEnv = await prepareLocalCommitMessageAgentEnv(
      resolvedSettings.params.agentId,
      this.host.getCommitMessageAgentEnvironment?.()
    )
    if (!localEnv.ok) {
      return { success: false, error: localEnv.error }
    }
    return generateCommitMessageFromContext(context, resolvedSettings.params, {
      kind: 'local',
      cwd: target.worktree.path,
      ...(localEnv.env ? { env: localEnv.env } : {})
    })
  }

  async cancelRuntimeGenerateCommitMessage(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      await provider?.cancelGenerateCommitMessage(target.worktree.path)
      return { ok: true }
    }
    cancelGenerateCommitMessageLocal(target.worktree.path)
    return { ok: true }
  }

  async stageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.stageFile(target.worktree.path, relativePath)
      return { ok: true }
    }
    await stageFile(target.worktree.path, relativePath)
    return { ok: true }
  }

  async unstageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.unstageFile(target.worktree.path, relativePath)
      return { ok: true }
    }
    await unstageFile(target.worktree.path, relativePath)
    return { ok: true }
  }

  async bulkStageRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.bulkStageFiles(target.worktree.path, relativePaths)
      return { ok: true }
    }
    await bulkStageFiles(target.worktree.path, relativePaths)
    return { ok: true }
  }

  async bulkUnstageRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.bulkUnstageFiles(target.worktree.path, relativePaths)
      return { ok: true }
    }
    await bulkUnstageFiles(target.worktree.path, relativePaths)
    return { ok: true }
  }

  async bulkDiscardRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.bulkDiscardChanges(target.worktree.path, relativePaths)
      return { ok: true }
    }
    await bulkDiscardChanges(target.worktree.path, relativePaths)
    return { ok: true }
  }

  async discardRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_git_unavailable')
      }
      await provider.discardChanges(target.worktree.path, relativePath)
      return { ok: true }
    }
    await discardChanges(target.worktree.path, relativePath)
    return { ok: true }
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
        throw new Error('remote_git_unavailable')
      }
      return provider.getRemoteFileUrl(target.worktree.path, normalizedRelativePath, line)
    }
    return getRemoteFileUrl(target.worktree.path, normalizedRelativePath, line)
  }
}
