/* eslint-disable max-lines -- Why: runtime git dispatch stays in one boundary so local, SSH, and runtime-environment behavior remains comparable. */
import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitForkSyncExpectedUpstream,
  GitAddUpstreamRemoteResult,
  GitForkSyncResult,
  GitPushTarget,
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus,
  GitWorktreeInfo,
  GlobalSettings,
  Repo,
  TuiAgent,
  Worktree
} from '../../shared/types'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import { getCommitMessageModelDiscoveryHostKey } from '../../shared/commit-message-host-key'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  type ResolvedSourceControlAiGenerationParams
} from '../../shared/source-control-ai'
import type { SourceControlAiOperation } from '../../shared/source-control-ai-types'
import type { GitProviderStatusOptions } from '../providers/types'
import { getRemoteCommitUrl, getRemoteFileUrl } from '../git/repo'
import {
  abortMerge,
  abortRebase,
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
  getSubmoduleStatus as getGitSubmoduleStatus,
  stageFile,
  unstageFile
} from '../git/status'
import { checkoutBranch, listLocalBranches } from '../git/checkout'
import type { RuntimeGitCheckoutResult, RuntimeGitLocalBranches } from '../../shared/runtime-types'
import { getHistory as getGitHistory } from '../git/history'
import { getUpstreamStatus } from '../git/upstream'
import { gitFastForward, gitFetch, gitPull, gitPullRebaseFromBase, gitPush } from '../git/remote'
import { gitAddUpstreamRemote, gitSyncForkDefaultBranch } from '../git/fork-sync'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import {
  cancelGenerateCommitMessageLocal,
  cancelGeneratePullRequestFieldsLocal,
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext,
  resolveCommitMessageSettings,
  type CommitMessageGenerationTarget,
  type DiscoverCommitMessageModelsResult,
  type GenerateCommitMessageResult,
  type GeneratePullRequestFieldsResult
} from '../text-generation/commit-message-text-generation'
import type {
  CommitMessageAgentEnvironmentResolvers,
  CommitMessageAgentRuntimeTarget
} from '../text-generation/commit-message-agent-environment'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import { getPullRequestDraftContext } from '../text-generation/pull-request-context'
import { normalizeRuntimeRelativePath } from './runtime-relative-paths'
import { gitExecFileAsync } from '../git/runner'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { resolveHostedReviewBodyForGeneration } from '../source-control/pull-request-template'
import type { HostedReviewProvider } from '../../shared/hosted-review'

export type ResolvedRuntimeGitWorktree = Worktree & { git: GitWorktreeInfo }
type RuntimeCommitMessageSettingsOverride = Partial<
  Pick<
    GlobalSettings,
    'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides' | 'enableGitHubAttribution'
  >
> & {
  commitMessageDiscoveryHostKey?: string
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
}

function getRuntimeGitGenerationSettings(
  settings: GlobalSettings,
  settingsOverride: RuntimeCommitMessageSettingsOverride | undefined,
  operation: SourceControlAiOperation
): GlobalSettings {
  const mergedSettings = {
    ...settings,
    ...settingsOverride
  }
  if (
    settingsOverride?.commitMessageAi !== undefined &&
    settingsOverride.sourceControlAi === undefined
  ) {
    mergedSettings.sourceControlAi = mergeLegacyCommitMessageAiIntoSourceControlAi(
      settings.sourceControlAi,
      settingsOverride.commitMessageAi,
      { pullRequestInstructionsFromLegacy: operation === 'pullRequest' }
    )
  }
  return mergedSettings
}

function normalizeRuntimeGitRelativePath(filePath: string): string {
  const relativePath = normalizeRuntimeRelativePath(filePath)
  if (relativePath === '') {
    // Why: git mutation APIs treat an empty pathspec as the worktree root;
    // runtime RPC must never let malformed file paths discard whole worktrees.
    throw new Error('invalid_relative_path')
  }
  return relativePath
}

type RuntimeGitTarget = {
  worktree: ResolvedRuntimeGitWorktree
  repo?: Repo
  connectionId?: string
  localGitOptions?: GitRuntimeOptions
}

function localGitOptionsForTarget(target: RuntimeGitTarget): GitRuntimeOptions {
  return target.connectionId ? {} : (target.localGitOptions ?? {})
}

function localAgentRuntimeTargetForTarget(
  target: RuntimeGitTarget
): CommitMessageAgentRuntimeTarget {
  const wslDistro = localGitOptionsForTarget(target).wslDistro
  return wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
}

function localTextGenerationTargetForTarget(
  target: RuntimeGitTarget,
  env?: NodeJS.ProcessEnv
): Extract<CommitMessageGenerationTarget, { kind: 'local' }> {
  const wslDistro = localGitOptionsForTarget(target).wslDistro
  return {
    kind: 'local',
    cwd: target.worktree.path,
    ...(wslDistro ? { wslDistro } : {}),
    ...(env ? { env } : {})
  }
}

export type RuntimeGitCommandHost = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
  getRuntimeSettings(): GlobalSettings
  getCommitMessageAgentEnvironment?(): CommitMessageAgentEnvironmentResolvers | undefined
}

export class RuntimeGitCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async getRuntimeGitStatus(
    worktreeSelector: string,
    options?: GitProviderStatusOptions
  ): Promise<GitStatusResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return options
        ? provider.getStatus(target.worktree.path, options)
        : provider.getStatus(target.worktree.path)
    }
    const gitOptions = localGitOptionsForTarget(target)
    return options
      ? getGitStatus(target.worktree.path, { ...options, ...gitOptions })
      : getGitStatus(target.worktree.path, gitOptions)
  }

  async getRuntimeGitSubmoduleStatus(
    worktreeSelector: string,
    submodulePath: string,
    area: GitStagingArea = 'unstaged'
  ): Promise<GitStatusResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getSubmoduleStatus(target.worktree.path, submodulePath, area)
    }
    return getGitSubmoduleStatus(target.worktree.path, submodulePath, {
      ...localGitOptionsForTarget(target),
      ...(area === 'staged' ? { staged: true } : {})
    })
  }

  async checkRuntimeGitIgnoredPaths(
    worktreeSelector: string,
    relativePaths: string[]
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.checkIgnoredPaths(target.worktree.path, relativePaths)
    }
    return checkIgnoredPaths(target.worktree.path, relativePaths, localGitOptionsForTarget(target))
  }

  async getRuntimeGitHistory(
    worktreeSelector: string,
    options: GitHistoryOptions = {}
  ): Promise<GitHistoryResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getHistory(target.worktree.path, options)
    }
    return getGitHistory(target.worktree.path, {
      ...options,
      ...localGitOptionsForTarget(target)
    })
  }

  async getRuntimeGitConflictOperation(worktreeSelector: string): Promise<GitConflictOperation> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.detectConflictOperation(target.worktree.path)
    }
    return detectConflictOperation(target.worktree.path)
  }

  async abortRuntimeGitMerge(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.abortMerge(target.worktree.path)
      return { ok: true }
    }
    await abortMerge(target.worktree.path, localGitOptionsForTarget(target))
    return { ok: true }
  }

  async abortRuntimeGitRebase(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.abortRebase(target.worktree.path)
      return { ok: true }
    }
    await abortRebase(target.worktree.path, localGitOptionsForTarget(target))
    return { ok: true }
  }

  async checkoutRuntimeGitBranch(
    worktreeSelector: string,
    branch: string
  ): Promise<RuntimeGitCheckoutResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.checkoutBranch(target.worktree.path, branch)
      return { ok: true, branch }
    }
    await checkoutBranch(target.worktree.path, branch, localGitOptionsForTarget(target))
    return { ok: true, branch }
  }

  async listRuntimeGitLocalBranches(worktreeSelector: string): Promise<RuntimeGitLocalBranches> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.listLocalBranches(target.worktree.path)
    }
    return listLocalBranches(target.worktree.path, localGitOptionsForTarget(target))
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
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getDiff(target.worktree.path, relativePath, staged, compareAgainstHead)
    }
    return getDiff(
      target.worktree.path,
      relativePath,
      staged,
      compareAgainstHead,
      localGitOptionsForTarget(target)
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

  async getRuntimeGitUpstreamStatus(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<GitUpstreamStatus> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getUpstreamStatus(target.worktree.path, pushTarget)
    }
    return getUpstreamStatus(target.worktree.path, pushTarget, localGitOptionsForTarget(target))
  }

  async fetchRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.fetchRemote(target.worktree.path, pushTarget)
      return { ok: true }
    }
    await gitFetch(target.worktree.path, pushTarget, localGitOptionsForTarget(target))
    return { ok: true }
  }

  async syncRuntimeGitForkDefaultBranch(
    worktreeSelector: string,
    expectedUpstream: GitForkSyncExpectedUpstream
  ): Promise<GitForkSyncResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.syncForkDefaultBranch(target.worktree.path, expectedUpstream)
    }
    return gitSyncForkDefaultBranch(
      target.worktree.path,
      expectedUpstream,
      localGitOptionsForTarget(target)
    )
  }

  async addRuntimeGitUpstreamRemote(
    worktreeSelector: string,
    expectedUpstream: GitForkSyncExpectedUpstream
  ): Promise<GitAddUpstreamRemoteResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.addUpstreamRemote(target.worktree.path, expectedUpstream)
    }
    return gitAddUpstreamRemote(
      target.worktree.path,
      expectedUpstream,
      localGitOptionsForTarget(target)
    )
  }

  async pullRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.pullBranch(target.worktree.path, pushTarget)
      return { ok: true }
    }
    await gitPull(target.worktree.path, pushTarget, localGitOptionsForTarget(target))
    return { ok: true }
  }

  async fastForwardRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.fastForwardBranch(target.worktree.path, pushTarget)
      return { ok: true }
    }
    await gitFastForward(target.worktree.path, pushTarget, localGitOptionsForTarget(target))
    return { ok: true }
  }

  async rebaseRuntimeGitFromBase(worktreeSelector: string, baseRef: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.rebaseFromBase(target.worktree.path, baseRef)
      return { ok: true }
    }
    await gitPullRebaseFromBase(target.worktree.path, baseRef, localGitOptionsForTarget(target))
    return { ok: true }
  }

  async pushRuntimeGit(
    worktreeSelector: string,
    publish?: boolean,
    pushTarget?: GitPushTarget,
    forceWithLease?: boolean
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.pushBranch(target.worktree.path, publish === true, pushTarget, {
        forceWithLease: forceWithLease === true
      })
      return { ok: true }
    }
    await gitPush(target.worktree.path, publish === true, pushTarget, {
      forceWithLease: forceWithLease === true,
      ...localGitOptionsForTarget(target)
    })
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
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
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
    return getBranchDiff(
      target.worktree.path,
      {
        mergeBase: compare.mergeBase,
        headOid: compare.headOid,
        filePath: relativePath,
        oldPath: oldRelativePath
      },
      localGitOptionsForTarget(target)
    )
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
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getCommitDiff(target.worktree.path, {
        commitOid: args.commitOid,
        parentOid: args.parentOid,
        filePath: relativePath,
        oldPath: oldRelativePath
      })
    }
    return getCommitDiff(
      target.worktree.path,
      {
        commitOid: args.commitOid,
        parentOid: args.parentOid,
        filePath: relativePath,
        oldPath: oldRelativePath
      },
      localGitOptionsForTarget(target)
    )
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
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.commit(target.worktree.path, message)
    }
    return commitChanges(target.worktree.path, message, localGitOptionsForTarget(target))
  }

  async generateRuntimeCommitMessage(
    worktreeSelector: string,
    settingsOverride?: RuntimeCommitMessageSettingsOverride
  ): Promise<GenerateCommitMessageResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const discoveryHostKey =
      settingsOverride?.commitMessageDiscoveryHostKey ??
      getCommitMessageModelDiscoveryHostKey(target.connectionId ?? null)
    const resolvedSettings = settingsOverride?.sourceControlAiResolvedParams
      ? { ok: true as const, params: settingsOverride.sourceControlAiResolvedParams }
      : resolveCommitMessageSettings(
          getRuntimeGitGenerationSettings(
            this.host.getRuntimeSettings(),
            settingsOverride,
            'commitMessage'
          ),
          discoveryHostKey,
          'commitMessage',
          target.repo ?? null
        )
    if (!resolvedSettings.ok) {
      return { success: false, error: resolvedSettings.error }
    }

    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        return {
          success: false,
          error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
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
        execute: (plan, cwd, timeoutMs, operation) =>
          provider.executeCommitMessagePlan(plan, cwd, timeoutMs, operation),
        missingBinaryLocation: 'remote PATH'
      })
    }

    let context: CommitMessageDraftContext | null
    try {
      context = await getStagedCommitContext(target.worktree.path, localGitOptionsForTarget(target))
    } catch (error) {
      console.error('[runtime-git] Failed to read staged commit context:', error)
      return { success: false, error: 'Failed to read staged changes.' }
    }
    if (!context) {
      return { success: false, error: 'No staged changes to summarize.' }
    }
    const localEnv = await prepareLocalCommitMessageAgentEnv(
      resolvedSettings.params.agentId,
      this.host.getCommitMessageAgentEnvironment?.(),
      localAgentRuntimeTargetForTarget(target)
    )
    if (!localEnv.ok) {
      return { success: false, error: localEnv.error }
    }
    return generateCommitMessageFromContext(
      context,
      resolvedSettings.params,
      localTextGenerationTargetForTarget(target, localEnv.env)
    )
  }

  async cancelRuntimeGenerateCommitMessage(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      await provider?.cancelGenerateCommitMessage(target.worktree.path, 'commit-message')
      return { ok: true }
    }
    cancelGenerateCommitMessageLocal(target.worktree.path)
    return { ok: true }
  }

  async generateRuntimePullRequestFields(
    worktreeSelector: string,
    input: {
      base: string
      title: string
      body: string
      draft: boolean
      provider?: HostedReviewProvider
      useTemplate?: boolean
    },
    settingsOverride?: RuntimeCommitMessageSettingsOverride
  ): Promise<GeneratePullRequestFieldsResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const discoveryHostKey =
      settingsOverride?.commitMessageDiscoveryHostKey ??
      getCommitMessageModelDiscoveryHostKey(target.connectionId ?? null)
    const resolvedSettings = settingsOverride?.sourceControlAiResolvedParams
      ? { ok: true as const, params: settingsOverride.sourceControlAiResolvedParams }
      : resolveCommitMessageSettings(
          getRuntimeGitGenerationSettings(
            this.host.getRuntimeSettings(),
            settingsOverride,
            'pullRequest'
          ),
          discoveryHostKey,
          'pullRequest',
          target.repo ?? null
        )
    if (!resolvedSettings.ok) {
      return { success: false, error: resolvedSettings.error }
    }

    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId && !provider) {
      return {
        success: false,
        error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
      }
    }
    let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
    try {
      const currentBody = await resolveHostedReviewBodyForGeneration({
        body: input.body,
        repoPath: target.worktree.path,
        connectionId: target.connectionId,
        provider: input.provider,
        useTemplate: input.useTemplate
      })
      context = target.connectionId
        ? await getPullRequestDraftContext((argv) => provider!.exec(argv, target.worktree.path), {
            base: input.base,
            currentTitle: input.title,
            currentBody,
            currentDraft: input.draft
          })
        : await getPullRequestDraftContext(
            (argv, options) =>
              gitExecFileAsync(argv, {
                cwd: target.worktree.path,
                ...localGitOptionsForTarget(target),
                ...options
              }),
            {
              base: input.base,
              currentTitle: input.title,
              currentBody,
              currentDraft: input.draft
            }
          )
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to prepare branch for PR details.'
      }
    }
    if (!context) {
      return { success: false, error: 'No branch changes to summarize.' }
    }

    if (target.connectionId) {
      return generatePullRequestFieldsFromContext(context, resolvedSettings.params, {
        kind: 'remote',
        cwd: target.worktree.path,
        execute: (plan, cwd, timeoutMs, operation) =>
          provider!.executeCommitMessagePlan(plan, cwd, timeoutMs, operation),
        missingBinaryLocation: 'remote PATH'
      })
    }

    const localEnv = await prepareLocalCommitMessageAgentEnv(
      resolvedSettings.params.agentId,
      this.host.getCommitMessageAgentEnvironment?.(),
      localAgentRuntimeTargetForTarget(target)
    )
    if (!localEnv.ok) {
      return { success: false, error: localEnv.error }
    }
    return generatePullRequestFieldsFromContext(
      context,
      resolvedSettings.params,
      localTextGenerationTargetForTarget(target, localEnv.env)
    )
  }

  async cancelRuntimeGeneratePullRequestFields(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      await provider?.cancelGenerateCommitMessage(target.worktree.path, 'pull-request-fields')
      return { ok: true }
    }
    cancelGeneratePullRequestFieldsLocal(target.worktree.path)
    return { ok: true }
  }

  async discoverRuntimeCommitMessageModels(
    worktreeSelector: string,
    agentId: string,
    settingsOverride?: Pick<RuntimeCommitMessageSettingsOverride, 'agentCmdOverrides'>
  ): Promise<DiscoverCommitMessageModelsResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const typedAgentId = agentId as TuiAgent
    const agentCommandOverride =
      settingsOverride?.agentCmdOverrides?.[typedAgentId] ??
      this.host.getRuntimeSettings().agentCmdOverrides?.[typedAgentId]
    if (target.connectionId) {
      const provider = getSshGitProvider(target.connectionId)
      if (!provider) {
        return {
          success: false,
          error: `No git provider for connection "${target.connectionId}"`
        }
      }
      return discoverCommitMessageModelsRemote(
        typedAgentId,
        target.worktree.path,
        (plan, cwd, timeoutMs) => provider.executeCommitMessagePlan(plan, cwd, timeoutMs),
        agentCommandOverride
      )
    }
    const localEnv = await prepareLocalCommitMessageAgentEnv(
      typedAgentId,
      this.host.getCommitMessageAgentEnvironment?.(),
      localAgentRuntimeTargetForTarget(target)
    )
    if (!localEnv.ok) {
      return { success: false, error: localEnv.error }
    }
    const localOptions = localGitOptionsForTarget(target)
    return localOptions.wslDistro
      ? discoverCommitMessageModelsLocal(typedAgentId, localEnv.env, agentCommandOverride, {
          cwd: target.worktree.path,
          wslDistro: localOptions.wslDistro
        })
      : discoverCommitMessageModelsLocal(typedAgentId, localEnv.env, agentCommandOverride)
  }

  async stageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.stageFile(target.worktree.path, relativePath)
      return { ok: true }
    }
    await stageFile(target.worktree.path, relativePath, localGitOptionsForTarget(target))
    return { ok: true }
  }

  async unstageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.unstageFile(target.worktree.path, relativePath)
      return { ok: true }
    }
    await unstageFile(target.worktree.path, relativePath, localGitOptionsForTarget(target))
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
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.bulkStageFiles(target.worktree.path, relativePaths)
      return { ok: true }
    }
    await bulkStageFiles(target.worktree.path, relativePaths, localGitOptionsForTarget(target))
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
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.bulkUnstageFiles(target.worktree.path, relativePaths)
      return { ok: true }
    }
    await bulkUnstageFiles(target.worktree.path, relativePaths, localGitOptionsForTarget(target))
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
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.bulkDiscardChanges(target.worktree.path, relativePaths)
      return { ok: true }
    }
    await bulkDiscardChanges(target.worktree.path, relativePaths, localGitOptionsForTarget(target))
    return { ok: true }
  }

  async discardRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.discardChanges(target.worktree.path, relativePath)
      return { ok: true }
    }
    await discardChanges(target.worktree.path, relativePath, localGitOptionsForTarget(target))
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
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getRemoteFileUrl(target.worktree.path, normalizedRelativePath, line)
    }
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
    return getRemoteCommitUrl(target.worktree.path, sha)
  }
}
