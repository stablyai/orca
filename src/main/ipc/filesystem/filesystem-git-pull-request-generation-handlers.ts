import {
  textGenerationFailure,
  textGenerationFailureCodeFields
} from '../../../shared/text-generation-failure-copy'
import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control/ai/source-control-ai-operation-resolution'
import type { HostedReviewProvider } from '../../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  cancelGeneratePullRequestFieldsLocal,
  generatePullRequestFieldsFromContext,
  resolveCommitMessageSettings,
  type GeneratePullRequestFieldsResult
} from '../../text-generation/commit-message-text-generation'
import { getCommitMessageModelDiscoveryHostKey } from '../../../shared/source-control/ai/generation/commit-message-host-key'
import { getPullRequestDraftContext } from '../../text-generation/pull-request-context'
import { sourceControlSubscriptionTarget } from '../../text-generation/source-control-subscription-target'
import { prepareLocalCommitMessageAgentEnv } from '../../text-generation/commit-message-agent-environment'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../../providers/ssh-host-not-served-error'
import { resolveRegisteredWorktreePath } from '../worktrees/removal/registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { gitExecFileAsync } from '../../git/runner'
import { withLinkedIssueDraftContext } from '../../../shared/source-control/ai/recipes/source-control-ai-action-variables'
import { resolveSourceControlAiLinkedIssueMeta } from '../source-control/source-control-ai-linked-issue'
import { resolveHostedReviewBodyForGeneration } from '../../source-control/pull-request-template'
import { loadPullRequestLinkedIssue } from '../../source-control/pull-request-linked-issue'
import {
  beginLocalGenerationRequest,
  localGenerationRequestStop,
  localGenerationCanceledResult
} from '../../text-generation/source-control-generation-lanes'
import { registeredGenerationTargetFence } from './filesystem-generation-registration-fence'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import {
  getLocalAgentRuntimeTarget,
  getLocalTextGenerationTarget,
  getRepoForSourceControlAi
} from './filesystem-source-control-ai-targets'

export function registerFilesystemGitPullRequestGenerationHandlers(
  context: FilesystemHandlerContext
): void {
  const { store, commitMessageAgentEnv } = context
  ipcMain.handle(
    'git:generatePullRequestFields',
    async (
      event,
      args: {
        worktreePath: string
        // Raw (unstripped) meta key; validated against worktreePath before any meta read.
        worktreeId?: string
        repoId?: string
        base: string
        title: string
        body: string
        draft: boolean
        provider?: HostedReviewProvider
        useTemplate?: boolean
        connectionId?: string
        generationId?: string
        sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
        sourceControlAi?: GlobalSettings['sourceControlAi']
        agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
      }
    ): Promise<GeneratePullRequestFieldsResult> => {
      const request = beginLocalGenerationRequest(
        'pull-request-fields',
        args.generationId === undefined
          ? undefined
          : { owner: `window:${event.sender.id}`, generationId: args.generationId }
      )
      try {
        const discoveryHostKey = getCommitMessageModelDiscoveryHostKey(args.connectionId ?? null)
        const baseSettings = store.getSettings()
        const registeredRepo = await getRepoForSourceControlAi(store, args)
        const requestSettings = {
          ...baseSettings,
          ...(args.sourceControlAi !== undefined ? { sourceControlAi: args.sourceControlAi } : {}),
          ...(args.agentCmdOverrides !== undefined
            ? { agentCmdOverrides: args.agentCmdOverrides }
            : {})
        }
        const repo = args.sourceControlAiResolvedParams ? null : registeredRepo
        if (request?.canceled) {
          return localGenerationCanceledResult()
        }
        const resolvedSettings = args.sourceControlAiResolvedParams
          ? { ok: true as const, params: args.sourceControlAiResolvedParams }
          : resolveCommitMessageSettings(requestSettings, discoveryHostKey, 'pullRequest', repo)
        if (!resolvedSettings.ok) {
          return {
            success: false,
            error: resolvedSettings.error,
            ...textGenerationFailureCodeFields(resolvedSettings)
          }
        }
        if (args.connectionId) {
          return { success: false, error: SSH_HOST_NOT_SERVED_MESSAGE }
        }

        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        if (request) {
          request.bindTarget(getLocalTextGenerationTarget(worktreePath, gitOptions))
        }
        if (request?.canceled) {
          return localGenerationCanceledResult()
        }
        const issueMeta = resolveSourceControlAiLinkedIssueMeta(store, args, worktreePath)
        const linkedIssueDetailsPromise = loadPullRequestLinkedIssue({
          meta: issueMeta,
          provider: args.provider,
          repoPath: worktreePath,
          localGitOptions: gitOptions
        })
        // Preparation can return before this lookup settles; retain its error for the later await.
        void linkedIssueDetailsPromise.catch(() => undefined)
        let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
        try {
          const currentBody = await resolveHostedReviewBodyForGeneration({
            body: args.body,
            repoPath: worktreePath,
            provider: args.provider,
            useTemplate: args.useTemplate
          })
          if (request?.canceled) {
            return localGenerationCanceledResult()
          }
          context = await getPullRequestDraftContext(
            (argv, options) =>
              gitExecFileAsync(argv, {
                cwd: worktreePath,
                ...gitOptions,
                ...(options?.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
                ...(options?.timeoutMs === undefined && options?.timeout === undefined
                  ? {}
                  : { timeout: options?.timeoutMs ?? options?.timeout })
              }),
            {
              base: args.base,
              currentTitle: args.title,
              currentBody,
              currentDraft: args.draft
            }
          )
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : 'Failed to prepare branch for PR details.'
          }
        }
        if (request?.canceled) {
          return localGenerationCanceledResult(context?.branchChangedByPreparation)
        }
        if (!context) {
          return { success: false, ...textGenerationFailure('noBranchChanges') }
        }
        const linkedIssueDetails = await linkedIssueDetailsPromise
        if (request?.canceled) {
          return localGenerationCanceledResult(context.branchChangedByPreparation)
        }
        context = {
          ...withLinkedIssueDraftContext(context, issueMeta?.linkedIssue),
          ...(args.provider ? { provider: args.provider } : {}),
          ...(linkedIssueDetails ? { linkedIssueDetails } : {})
        }
        const localEnv = await prepareLocalCommitMessageAgentEnv(
          resolvedSettings.params.agentId,
          commitMessageAgentEnv,
          getLocalAgentRuntimeTarget(gitOptions)
        )
        if (request?.canceled) {
          return localGenerationCanceledResult(context.branchChangedByPreparation)
        }
        if (!localEnv.ok) {
          return { success: false, error: localEnv.error }
        }
        return await generatePullRequestFieldsFromContext(
          context,
          resolvedSettings.params,
          sourceControlSubscriptionTarget(
            {
              ...getLocalTextGenerationTarget(worktreePath, gitOptions, localEnv.env),
              ...(request ? { generationRequest: request } : {})
            },
            resolvedSettings.params,
            registeredRepo ? commitMessageAgentEnv : undefined,
            registeredGenerationTargetFence(store, args, {
              registeredRepo,
              worktreePath,
              gitOptions
            })
          )
        )
      } finally {
        request?.release()
      }
    }
  )

  ipcMain.handle(
    'git:cancelGeneratePullRequestFields',
    async (
      event,
      args: { worktreePath: string; connectionId?: string; generationId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        return
      }
      const stop =
        args.generationId === undefined
          ? undefined
          : localGenerationRequestStop('pull-request-fields', {
              owner: `window:${event.sender.id}`,
              generationId: args.generationId
            })
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      if (stop) {
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        stop(getLocalTextGenerationTarget(worktreePath, gitOptions))
        return
      }
      cancelGeneratePullRequestFieldsLocal(worktreePath)
    }
  )
}
