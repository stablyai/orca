import { ipcMain } from 'electron'
import type { IssueDraftContext } from '../../../shared/issue-draft-generation'
import { getCommitMessageModelDiscoveryHostKey } from '../../../shared/commit-message-host-key'
import {
  cancelGenerateIssueFieldsLocal,
  generateIssueFieldsFromContext,
  resolveCommitMessageSettings,
  type GenerateIssueFieldsResult
} from '../../text-generation/commit-message-text-generation'
import { prepareLocalCommitMessageAgentEnv } from '../../text-generation/commit-message-agent-environment'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import {
  getLocalAgentRuntimeTarget,
  getLocalTextGenerationTarget,
  getRepoForSourceControlAi
} from './filesystem-source-control-ai-targets'

export function registerFilesystemGitIssueGenerationHandlers(
  context: FilesystemHandlerContext
): void {
  const { store, commitMessageAgentEnv } = context
  ipcMain.handle(
    'git:generateIssueFields',
    async (
      _event,
      args: {
        worktreePath: string
        repoId?: string
        title: string
        body: string
        repoSlug?: string | null
        availableLabels?: string[]
        connectionId?: string
      }
    ): Promise<GenerateIssueFieldsResult> => {
      const discoveryHostKey = getCommitMessageModelDiscoveryHostKey(args.connectionId ?? null)
      const repoForSourceControlAi = await getRepoForSourceControlAi(store, args)
      // Why: the relay runs the agent with args.worktreePath as cwd. For SSH the only
      // ownership proof is the repo registered for that connection — fail closed when
      // the path does not belong to it (CWE-862).
      if (args.connectionId && !repoForSourceControlAi) {
        return {
          success: false,
          error: 'Access denied: unknown remote repository or worktree path.'
        }
      }
      // Why: issue generation has no dedicated settings lane yet; the pullRequest lane picks the agent/model.
      const resolvedSettings = resolveCommitMessageSettings(
        store.getSettings(),
        discoveryHostKey,
        'pullRequest',
        repoForSourceControlAi
      )
      if (!resolvedSettings.ok) {
        return { success: false, error: resolvedSettings.error }
      }
      const draftContext: IssueDraftContext = {
        currentTitle: args.title,
        currentBody: args.body,
        repoSlug: args.repoSlug ?? null,
        availableLabels: Array.isArray(args.availableLabels)
          ? args.availableLabels.filter((label): label is string => typeof label === 'string')
          : []
      }
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return { success: false, error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE }
        }
        return generateIssueFieldsFromContext(draftContext, resolvedSettings.params, {
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
      const localEnv = await prepareLocalCommitMessageAgentEnv(
        resolvedSettings.params.agentId,
        commitMessageAgentEnv,
        getLocalAgentRuntimeTarget(gitOptions)
      )
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return generateIssueFieldsFromContext(
        draftContext,
        resolvedSettings.params,
        getLocalTextGenerationTarget(worktreePath, gitOptions, localEnv.env)
      )
    }
  )

  ipcMain.handle(
    'git:cancelGenerateIssueFields',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return
        }
        await provider.cancelGenerateCommitMessage(args.worktreePath, 'issue-fields')
        return
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      cancelGenerateIssueFieldsLocal(worktreePath)
    }
  )
}
