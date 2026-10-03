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

/**
 * The create dialog has no workspace, so generations run from the home
 * directory on the native host — same as folder-workspace title generation.
 */
function jiraSummaryGenerationCwd(): string {
  return os.homedir()
}

// Why: a lane cancellation token only exists once the plan starts; the
// sequence pair closes the window where Stop lands during env preparation.
let generationSeq = 0
let canceledSeq = 0

export function registerJiraIssueSummaryGenerationHandlers(
  store: Store,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  ipcMain.handle(
    'jira:generateIssueSummary',
    async (
      _event,
      args: JiraIssueSummaryGenerationContext
    ): Promise<JiraIssueSummaryGenerationResult> => {
      if (typeof args?.description !== 'string' || !args.description.trim()) {
        return { success: false, error: 'Description is required.' }
      }
      const seq = ++generationSeq
      // Why: reuses the branch-name agent/model choice — both title free-form
      // work from a short text, and it spares a separate settings surface.
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
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      if (canceledSeq >= seq) {
        return { success: false, error: 'Generation canceled.', canceled: true }
      }
      return generateJiraIssueSummaryFromContext(
        {
          description: args.description,
          projectName: typeof args.projectName === 'string' ? args.projectName : undefined,
          issueTypeName: typeof args.issueTypeName === 'string' ? args.issueTypeName : undefined
        },
        resolved.params,
        {
          kind: 'local',
          cwd: jiraSummaryGenerationCwd(),
          ...(localEnv.env ? { env: localEnv.env } : {})
        }
      )
    }
  )

  ipcMain.handle('jira:cancelGenerateIssueSummary', () => {
    canceledSeq = generationSeq
    cancelGenerateJiraIssueSummaryLocal(jiraSummaryGenerationCwd())
  })
}
