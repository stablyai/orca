import { ipcMain } from 'electron'
import os from 'node:os'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/commit-message-host-key'
import type {
  JiraIssueSummaryGenerationContext,
  JiraIssueSummaryGenerationResult
} from '../../shared/jira-issue-summary-generation'
import type { Store } from '../persistence'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import { resolveTextGenerationParams } from '../text-generation/commit-message-text-generation'
import {
  cancelGenerateJiraIssueSummaryLocal,
  generateJiraIssueSummaryFromContext
} from '../text-generation/jira-issue-summary-text-generation'

export function registerJiraIssueSummaryGenerationHandlers(
  store: Pick<Store, 'getSettings'>,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  const cwd = os.homedir()
  let activeRequest: { senderId: number } | undefined
  const cancel = (): void => {
    activeRequest = undefined
    cancelGenerateJiraIssueSummaryLocal(cwd)
  }

  ipcMain.handle(
    'jira:generateIssueSummary',
    async (
      event,
      args: JiraIssueSummaryGenerationContext
    ): Promise<JiraIssueSummaryGenerationResult> => {
      if (typeof args?.description !== 'string' || !args.description.trim()) {
        return { success: false, error: 'Description is required.' }
      }
      // The shared home-directory lane must not let one window stop another's request.
      if (activeRequest && activeRequest.senderId !== event.sender.id) {
        return {
          success: false,
          error: 'A Jira title is already being generated in another window.'
        }
      }
      cancel()
      const request = { senderId: event.sender.id }
      activeRequest = request
      const cancelOnDestroy = (): void => {
        if (activeRequest === request) {
          cancel()
        }
      }
      event.sender.once('destroyed', cancelOnDestroy)
      try {
        const resolved = resolveTextGenerationParams(
          store.getSettings(),
          LOCAL_COMMIT_MESSAGE_HOST_KEY,
          'branchName',
          null
        )
        if (!resolved.ok) {
          return { success: false, error: resolved.error }
        }
        const localEnv = await prepareLocalCommitMessageAgentEnv(
          resolved.params.agentId,
          commitMessageAgentEnv
        )
        if (activeRequest !== request) {
          return { success: false, error: 'Generation canceled.', canceled: true }
        }
        if (!localEnv.ok) {
          return { success: false, error: localEnv.error }
        }
        return await generateJiraIssueSummaryFromContext(
          {
            description: args.description,
            projectName: typeof args.projectName === 'string' ? args.projectName : undefined,
            issueTypeName: typeof args.issueTypeName === 'string' ? args.issueTypeName : undefined
          },
          resolved.params,
          { kind: 'local', cwd, ...(localEnv.env ? { env: localEnv.env } : {}) }
        )
      } finally {
        event.sender.removeListener('destroyed', cancelOnDestroy)
        if (activeRequest === request) {
          activeRequest = undefined
        }
      }
    }
  )

  ipcMain.handle('jira:cancelGenerateIssueSummary', (event) => {
    if (activeRequest?.senderId === event.sender.id) {
      cancel()
    }
  })
}
