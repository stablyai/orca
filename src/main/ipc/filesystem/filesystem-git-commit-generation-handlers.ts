import {
  textGenerationFailure,
  textGenerationFailureCodeFields
} from '../../../shared/text-generation-failure-copy'
import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control-ai'
import {
  cancelGenerateCommitMessageLocal,
  generateCommitMessageFromContext,
  resolveCommitMessageSettings,
  type GenerateCommitMessageResult
} from '../../text-generation/commit-message-text-generation'
import { getCommitMessageModelDiscoveryHostKey } from '../../../shared/commit-message-host-key'
import { getStagedCommitContext } from '../../git/status'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../../providers/ssh-host-not-served-error'
import { resolveRegisteredWorktreePath } from '../worktrees/removal/registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { withLinkedIssueDraftContext } from '../../../shared/source-control-ai-action-variables'
import { resolveSourceControlAiLinkedIssue } from '../source-control-ai-linked-issue'
import { sourceControlSubscriptionTarget } from '../../text-generation/source-control-subscription-target'
import { prepareLocalCommitMessageAgentEnv } from '../../text-generation/commit-message-agent-environment'
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

export function registerFilesystemGitCommitGenerationHandlers(
  context: FilesystemHandlerContext
): void {
  const { store, commitMessageAgentEnv } = context
  ipcMain.handle(
    'git:generateCommitMessage',
    async (
      event,
      args: {
        worktreePath: string
        // Raw (unstripped) meta key; validated against worktreePath before any meta read.
        worktreeId?: string
        repoId?: string
        connectionId?: string
        generationId?: string
        sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
        sourceControlAi?: GlobalSettings['sourceControlAi']
        agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
      }
    ): Promise<GenerateCommitMessageResult> => {
      const request = beginLocalGenerationRequest(
        'commit-message',
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
          : resolveCommitMessageSettings(requestSettings, discoveryHostKey, 'commitMessage', repo)
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
        let context
        try {
          context = await getStagedCommitContext(worktreePath, {
            ...gitOptions,
            admissionTier: 'interactive'
          })
        } catch (error) {
          console.error('[filesystem] Failed to read staged commit context:', error)
          return {
            success: false,
            ...textGenerationFailure('stagedChangesReadFailed')
          }
        }
        if (request?.canceled) {
          return localGenerationCanceledResult()
        }
        if (!context) {
          return { success: false, ...textGenerationFailure('noStagedChanges') }
        }
        context = withLinkedIssueDraftContext(
          context,
          resolveSourceControlAiLinkedIssue(store, args, worktreePath)
        )
        const localEnv = await prepareLocalCommitMessageAgentEnv(
          resolvedSettings.params.agentId,
          commitMessageAgentEnv,
          getLocalAgentRuntimeTarget(gitOptions)
        )
        if (request?.canceled) {
          return localGenerationCanceledResult()
        }
        if (!localEnv.ok) {
          return { success: false, error: localEnv.error }
        }
        return await generateCommitMessageFromContext(
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
    'git:cancelGenerateCommitMessage',
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
          : localGenerationRequestStop('commit-message', {
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
      cancelGenerateCommitMessageLocal(worktreePath)
    }
  )
}
