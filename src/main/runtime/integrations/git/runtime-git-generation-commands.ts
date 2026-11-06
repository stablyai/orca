import { discoverRuntimeCommitMessageModels } from './runtime-git-model-discovery'
import {
  textGenerationFailure,
  textGenerationFailureCodeFields
} from '../../../../shared/text-generation-failure-copy'
import type { CommitMessageDraftContext } from '../../../../shared/source-control/ai/generation/commit-message-generation'
import { getCommitMessageModelDiscoveryHostKey } from '../../../../shared/source-control/ai/generation/commit-message-host-key'
import type { HostedReviewProvider } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { withLinkedIssueDraftContext } from '../../../../shared/source-control/ai/recipes/source-control-ai-action-variables'
import { getStagedCommitContext } from '../../../git/source-control/staged-commit-context'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../../../providers/ssh-host-not-served-error'
import { loadPullRequestLinkedIssue } from '../../../source-control/pull-request-linked-issue'
import { resolveHostedReviewBodyForGeneration } from '../../../source-control/pull-request-template'
import { prepareLocalCommitMessageAgentEnv } from '../../../text-generation/commit-message-agent-environment'
import { sourceControlSubscriptionTarget } from '../../../text-generation/source-control-subscription-target'
import {
  cancelGenerateCommitMessageLocal,
  cancelGeneratePullRequestFieldsLocal,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext,
  resolveCommitMessageSettings
} from '../../../text-generation/commit-message-text-generation'
import type {
  DiscoverCommitMessageModelsResult,
  GenerateCommitMessageResult
} from '../../../text-generation/source-control-text-generation-types'
import type { GeneratePullRequestFieldsResult } from '../../../text-generation/commit-message-text-generation'
import { getPullRequestDraftContext } from '../../../text-generation/pull-request-context'
import {
  beginLocalGenerationRequest,
  localGenerationRequestStop,
  localGenerationCanceledResult as canceledGenerationResult,
  type SourceControlGenerationRequestIdentity
} from '../../../text-generation/source-control-generation-lanes'
import {
  localGitOptionsForTarget,
  runtimeGitRouteForTarget,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'
import {
  getRuntimeGitGenerationSettings,
  runtimeGitGenerationTargetCurrent,
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
    settingsOverride?: RuntimeCommitMessageSettingsOverride,
    identity?: SourceControlGenerationRequestIdentity
  ): Promise<GenerateCommitMessageResult> {
    const request = beginLocalGenerationRequest('commit-message', identity)
    try {
      const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
      const route = runtimeGitRouteForTarget(target)
      if (route.kind === 'local') {
        request?.bindTarget(localTextGenerationTargetForTarget(target))
      }
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
        return {
          success: false,
          error: resolvedSettings.error,
          ...textGenerationFailureCodeFields(resolvedSettings)
        }
      }
      if (route.kind === 'ssh') {
        return { success: false, error: SSH_HOST_NOT_SERVED_MESSAGE }
      }
      if (request?.canceled) {
        return canceledGenerationResult()
      }
      let context: CommitMessageDraftContext | null
      try {
        context = await getStagedCommitContext(target.worktree.path, {
          ...localGitOptionsForTarget(target),
          admissionTier: 'interactive'
        })
      } catch (error) {
        console.error('[runtime-git] Failed to read staged commit context:', error)
        return { success: false, ...textGenerationFailure('stagedChangesReadFailed') }
      }
      if (request?.canceled) {
        return canceledGenerationResult()
      }
      if (!context) {
        return { success: false, ...textGenerationFailure('noStagedChanges') }
      }
      context = withLinkedIssueDraftContext(context, linkedIssueForTarget(this.host, target))
      const localEnv = await prepareLocalCommitMessageAgentEnv(
        resolvedSettings.params.agentId,
        this.host.getCommitMessageAgentEnvironment?.(),
        localAgentRuntimeTargetForTarget(target)
      )
      if (request?.canceled) {
        return canceledGenerationResult()
      }
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return await generateCommitMessageFromContext(
        context,
        resolvedSettings.params,
        sourceControlSubscriptionTarget(
          localTextGenerationTargetForTarget(target, localEnv.env, request),
          resolvedSettings.params,
          this.host.getCommitMessageAgentEnvironment?.(),
          () => runtimeGitGenerationTargetCurrent(this.host, worktreeSelector, target)
        )
      )
    } finally {
      request?.release()
    }
  }

  async cancelRuntimeGenerateCommitMessage(
    worktreeSelector: string,
    identity?: SourceControlGenerationRequestIdentity
  ): Promise<{ ok: true }> {
    const stop = identity ? localGenerationRequestStop('commit-message', identity) : undefined
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    // SSH cancel must not touch the path-keyed local registry and abort unrelated same-path generation.
    if (runtimeGitRouteForTarget(target).kind === 'ssh') {
      return { ok: true }
    }
    if (stop) {
      stop(localTextGenerationTargetForTarget(target))
    } else {
      cancelGenerateCommitMessageLocal(target.worktree.path)
    }
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
    settingsOverride?: RuntimeCommitMessageSettingsOverride,
    identity?: SourceControlGenerationRequestIdentity
  ): Promise<GeneratePullRequestFieldsResult> {
    const request = beginLocalGenerationRequest('pull-request-fields', identity)
    try {
      const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
      const route = runtimeGitRouteForTarget(target)
      if (route.kind === 'local') {
        request?.bindTarget(localTextGenerationTargetForTarget(target))
      }
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
        return {
          success: false,
          error: resolvedSettings.error,
          ...textGenerationFailureCodeFields(resolvedSettings)
        }
      }
      if (route.kind === 'ssh') {
        return { success: false, error: SSH_HOST_NOT_SERVED_MESSAGE }
      }
      if (request?.canceled) {
        return canceledGenerationResult()
      }
      const issueMeta = linkedIssueMetaForTarget(this.host, target)
      const linkedIssueDetailsPromise = loadPullRequestLinkedIssue({
        meta: issueMeta,
        provider: input.provider,
        repoPath: target.worktree.path,
        localGitOptions: {
          ...localGitOptionsForTarget(target),
          admissionTier: 'interactive'
        }
      })
      void linkedIssueDetailsPromise.catch(() => undefined)
      let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
      try {
        const currentBody = await resolveHostedReviewBodyForGeneration({
          body: input.body,
          repoPath: target.worktree.path,
          provider: input.provider,
          useTemplate: input.useTemplate
        })
        if (request?.canceled) {
          return canceledGenerationResult()
        }
        context = await getPullRequestDraftContext(pullRequestDraftGitExec(target), {
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
      if (request?.canceled) {
        return canceledGenerationResult(context?.branchChangedByPreparation)
      }
      if (!context) {
        return { success: false, ...textGenerationFailure('noBranchChanges') }
      }
      const linkedIssueDetails = await linkedIssueDetailsPromise
      if (request?.canceled) {
        return canceledGenerationResult(context.branchChangedByPreparation)
      }
      context = {
        ...withLinkedIssueDraftContext(context, issueMeta?.linkedIssue),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(linkedIssueDetails ? { linkedIssueDetails } : {})
      }

      const localEnv = await prepareLocalCommitMessageAgentEnv(
        resolvedSettings.params.agentId,
        this.host.getCommitMessageAgentEnvironment?.(),
        localAgentRuntimeTargetForTarget(target)
      )
      if (request?.canceled) {
        return canceledGenerationResult(context.branchChangedByPreparation)
      }
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return await generatePullRequestFieldsFromContext(
        context,
        resolvedSettings.params,
        sourceControlSubscriptionTarget(
          localTextGenerationTargetForTarget(target, localEnv.env, request),
          resolvedSettings.params,
          this.host.getCommitMessageAgentEnvironment?.(),
          () => runtimeGitGenerationTargetCurrent(this.host, worktreeSelector, target)
        )
      )
    } finally {
      request?.release()
    }
  }

  async cancelRuntimeGeneratePullRequestFields(
    worktreeSelector: string,
    identity?: SourceControlGenerationRequestIdentity
  ): Promise<{ ok: true }> {
    const stop = identity ? localGenerationRequestStop('pull-request-fields', identity) : undefined
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    if (runtimeGitRouteForTarget(target).kind === 'ssh') {
      return { ok: true }
    }
    if (stop) {
      stop(localTextGenerationTargetForTarget(target))
    } else {
      cancelGeneratePullRequestFieldsLocal(target.worktree.path)
    }
    return { ok: true }
  }

  discoverRuntimeCommitMessageModels(
    worktreeSelector: string,
    agentId: string,
    settingsOverride?: Pick<RuntimeCommitMessageSettingsOverride, 'agentCmdOverrides'>
  ): Promise<DiscoverCommitMessageModelsResult> {
    return discoverRuntimeCommitMessageModels(
      this.host,
      worktreeSelector,
      agentId,
      settingsOverride
    )
  }
}
