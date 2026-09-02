import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control-ai'
import type { HostedReviewProvider } from '../../../shared/hosted-review'
import {
  cancelGeneratePullRequestFieldsLocal,
  generatePullRequestFieldsFromContext,
  resolveCommitMessageSettings,
  type GeneratePullRequestFieldsResult
} from '../../text-generation/commit-message-text-generation'
import { getCommitMessageModelDiscoveryHostKey } from '../../../shared/commit-message-host-key'
import { getPullRequestDraftContext } from '../../text-generation/pull-request-context'
import { prepareLocalCommitMessageAgentEnv } from '../../text-generation/commit-message-agent-environment'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { gitExecFileAsync } from '../../git/runner'
import { withLinkedIssueDraftContext } from '../../../shared/source-control-ai-action-variables'
import { resolveSourceControlAiLinkedIssueMeta } from '../source-control-ai-linked-issue'
import { resolveHostedReviewBodyForGeneration } from '../../source-control/pull-request-template'
import { loadPullRequestLinkedIssue } from '../../source-control/pull-request-linked-issue'
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
      _event,
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
        sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
        sourceControlAi?: GlobalSettings['sourceControlAi']
        agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
      }
    ): Promise<GeneratePullRequestFieldsResult> => {
      const discoveryHostKey = getCommitMessageModelDiscoveryHostKey(args.connectionId ?? null)
      const baseSettings = store.getSettings()
      const requestSettings = {
        ...baseSettings,
        ...(args.sourceControlAi !== undefined ? { sourceControlAi: args.sourceControlAi } : {}),
        ...(args.agentCmdOverrides !== undefined
          ? { agentCmdOverrides: args.agentCmdOverrides }
          : {})
      }
      const resolvedSettings = args.sourceControlAiResolvedParams
        ? { ok: true as const, params: args.sourceControlAiResolvedParams }
        : resolveCommitMessageSettings(
            requestSettings,
            discoveryHostKey,
            'pullRequest',
            await getRepoForSourceControlAi(store, args)
          )
      if (!resolvedSettings.ok) {
        return { success: false, error: resolvedSettings.error }
      }
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return {
            success: false,
            error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
          }
        }
        const issueMeta = resolveSourceControlAiLinkedIssueMeta(store, args)
        const linkedIssueDetailsPromise = loadPullRequestLinkedIssue({
          meta: issueMeta,
          provider: args.provider,
          repoPath: args.worktreePath,
          connectionId: args.connectionId
        })
        let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
        try {
          const currentBody = await resolveHostedReviewBodyForGeneration({
            body: args.body,
            repoPath: args.worktreePath,
            connectionId: args.connectionId,
            provider: args.provider,
            useTemplate: args.useTemplate
          })
          context = await getPullRequestDraftContext(
            (argv, commandOptions) =>
              commandOptions?.timeoutMs !== undefined
                ? provider.exec(argv, args.worktreePath, { timeoutMs: commandOptions.timeoutMs })
                : commandOptions?.timeout !== undefined
                  ? provider.exec(argv, args.worktreePath, { timeoutMs: commandOptions.timeout })
                  : provider.exec(argv, args.worktreePath),
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
        if (!context) {
          return { success: false, error: 'No branch changes to summarize.' }
        }
        const linkedIssueDetails = await linkedIssueDetailsPromise
        context = {
          ...withLinkedIssueDraftContext(context, issueMeta?.linkedIssue),
          ...(args.provider ? { provider: args.provider } : {}),
          ...(linkedIssueDetails ? { linkedIssueDetails } : {})
        }
        return generatePullRequestFieldsFromContext(context, resolvedSettings.params, {
          kind: 'remote',
          cwd: args.worktreePath,
          execute: (plan, cwd, timeoutMs, operation) =>
            provider.executeCommitMessagePlan(plan, cwd, timeoutMs, operation),
          missingBinaryLocation: 'remote PATH'
        })
      }

      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      const issueMeta = resolveSourceControlAiLinkedIssueMeta(store, args, worktreePath)
      const linkedIssueDetailsPromise = loadPullRequestLinkedIssue({
        meta: issueMeta,
        provider: args.provider,
        repoPath: worktreePath,
        connectionId: args.connectionId,
        localGitOptions: gitOptions
      })
      let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
      try {
        const currentBody = await resolveHostedReviewBodyForGeneration({
          body: args.body,
          repoPath: worktreePath,
          connectionId: args.connectionId,
          provider: args.provider,
          useTemplate: args.useTemplate
        })
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
          error: error instanceof Error ? error.message : 'Failed to prepare branch for PR details.'
        }
      }
      if (!context) {
        return { success: false, error: 'No branch changes to summarize.' }
      }
      const linkedIssueDetails = await linkedIssueDetailsPromise
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
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return generatePullRequestFieldsFromContext(
        context,
        resolvedSettings.params,
        getLocalTextGenerationTarget(worktreePath, gitOptions, localEnv.env)
      )
    }
  )

  ipcMain.handle(
    'git:cancelGeneratePullRequestFields',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return
        }
        await provider.cancelGenerateCommitMessage(args.worktreePath, 'pull-request-fields')
        return
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      cancelGeneratePullRequestFieldsLocal(worktreePath)
    }
  )
}
