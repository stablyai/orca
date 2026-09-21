import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import { getCommitMessageModelDiscoveryHostKey } from '../../shared/commit-message-host-key'
import type { HostedReviewProvider } from '../../shared/hosted-review'
import { withLinkedIssueDraftContext } from '../../shared/source-control-ai-action-variables'
import type { TuiAgent } from '../../shared/tui-agent'
import { getStagedCommitContext } from '../git/status'
import { SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-git-dispatch'
import { loadPullRequestLinkedIssue } from '../source-control/pull-request-linked-issue'
import { resolveHostedReviewBodyForGeneration } from '../source-control/pull-request-template'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import {
  cancelGenerateCommitMessageLocal,
  cancelGeneratePullRequestFieldsLocal,
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext,
  resolveCommitMessageSettings,
  type DiscoverCommitMessageModelsResult,
  type GenerateCommitMessageResult,
  type GeneratePullRequestFieldsResult
} from '../text-generation/commit-message-text-generation'
import { getPullRequestDraftContext } from '../text-generation/pull-request-context'
import {
  localGitOptionsForTarget,
  runtimeGitRouteForTarget,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'
import {
  getRuntimeGitGenerationSettings,
  linkedIssueForTarget,
  linkedIssueMetaForTarget,
  localAgentRuntimeTargetForTarget,
  localTextGenerationTargetForTarget,
  pullRequestDraftGitExec,
  type RuntimeCommitMessageSettingsOverride
} from './runtime-git-generation-context'

export class RuntimeGitGenerationCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async generateRuntimeCommitMessage(
    worktreeSelector: string,
    settingsOverride?: RuntimeCommitMessageSettingsOverride
  ): Promise<GenerateCommitMessageResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const route = runtimeGitRouteForTarget(target)
    const discoveryHostKey =
      settingsOverride?.commitMessageDiscoveryHostKey ??
      getCommitMessageModelDiscoveryHostKey(route.kind === 'ssh' ? route.connectionId : null)
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

    if (route.kind === 'ssh') {
      const provider = route.provider
      if (!provider) {
        return { success: false, error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE }
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
      context = withLinkedIssueDraftContext(context, linkedIssueForTarget(this.host, target))
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
      context = await getStagedCommitContext(target.worktree.path, {
        ...localGitOptionsForTarget(target),
        admissionTier: 'interactive'
      })
    } catch (error) {
      console.error('[runtime-git] Failed to read staged commit context:', error)
      return { success: false, error: 'Failed to read staged changes.' }
    }
    if (!context) {
      return { success: false, error: 'No staged changes to summarize.' }
    }
    context = withLinkedIssueDraftContext(context, linkedIssueForTarget(this.host, target))
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
    const route = runtimeGitRouteForTarget(target)
    if (route.kind === 'ssh') {
      // Cancelling an unreachable host is a no-op, not a local cancel: the local registry is keyed
      // by path and would abort an unrelated generation running here for the same path.
      await route.provider?.cancelGenerateCommitMessage(target.worktree.path, 'commit-message')
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
    const route = runtimeGitRouteForTarget(target)
    const discoveryHostKey =
      settingsOverride?.commitMessageDiscoveryHostKey ??
      getCommitMessageModelDiscoveryHostKey(route.kind === 'ssh' ? route.connectionId : null)
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

    const provider = route.kind === 'ssh' ? route.provider : null
    if (route.kind === 'ssh' && !provider) {
      return { success: false, error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE }
    }
    const issueMeta = linkedIssueMetaForTarget(this.host, target)
    const linkedIssueDetailsPromise = loadPullRequestLinkedIssue({
      meta: issueMeta,
      provider: input.provider,
      repoPath: target.worktree.path,
      connectionId: route.kind === 'ssh' ? route.connectionId : undefined,
      localGitOptions:
        route.kind === 'ssh'
          ? {}
          : {
              ...localGitOptionsForTarget(target),
              admissionTier: 'interactive'
            }
    })
    let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
    try {
      const currentBody = await resolveHostedReviewBodyForGeneration({
        body: input.body,
        repoPath: target.worktree.path,
        connectionId: route.kind === 'ssh' ? route.connectionId : undefined,
        provider: input.provider,
        useTemplate: input.useTemplate
      })
      context = await getPullRequestDraftContext(pullRequestDraftGitExec(target, route), {
        base: input.base,
        currentTitle: input.title,
        currentBody,
        currentDraft: input.draft
      })
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to prepare branch for PR details.'
      }
    }
    if (!context) {
      return { success: false, error: 'No branch changes to summarize.' }
    }
    const linkedIssueDetails = await linkedIssueDetailsPromise
    context = {
      ...withLinkedIssueDraftContext(context, issueMeta?.linkedIssue),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(linkedIssueDetails ? { linkedIssueDetails } : {})
    }

    if (route.kind === 'ssh') {
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
    const route = runtimeGitRouteForTarget(target)
    if (route.kind === 'ssh') {
      await route.provider?.cancelGenerateCommitMessage(target.worktree.path, 'pull-request-fields')
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
    const route = runtimeGitRouteForTarget(target)
    if (route.kind === 'ssh') {
      const provider = route.provider
      if (!provider) {
        return { success: false, error: `No git provider for connection "${route.connectionId}"` }
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
}
