import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'
import type {
  AiVaultFirstUserPromptArgs,
  AiVaultFirstUserPromptResult,
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSubagentListArgs,
  AiVaultSubagentListResult
} from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  AiVaultRankSessionsArgs,
  AiVaultRankSessionsResult
} from '../../shared/ai-vault-session-ai-query'
import type {
  AiVaultSearchSessionsArgs,
  AiVaultSearchSessionsResult
} from '../../shared/ai-vault-session-search-scope'

export type AiVaultApi = {
  listSessions: (args?: AiVaultListArgs) => Promise<AiVaultListResult>
  resolveSessionTitles: (args: AiVaultSessionTitlesArgs) => Promise<AiVaultSessionTitlesResult>
  cancelListSessions: (args: { requestToken: string }) => Promise<void>
  prepareSessionResume: (
    args: AiVaultPrepareSessionResumeArgs
  ) => Promise<AiVaultPrepareSessionResumeResult>
  /** Lists the Task subagent transcripts of one session, on demand. */
  listSubagentSessions: (args: AiVaultSubagentListArgs) => Promise<AiVaultSubagentListResult>
  /** Full first user prompt for copy/reuse (re-parses one transcript). */
  getFirstUserPrompt: (args: AiVaultFirstUserPromptArgs) => Promise<AiVaultFirstUserPromptResult>
  /** Moves a deletable session's transcript to the OS trash; local sessions only. */
  deleteSession: (args: AiVaultDeleteSessionArgs) => Promise<AiVaultDeleteSessionResult>
  /** Fires when any app window regains OS focus; returns an unsubscribe. */
  onWindowFocused: (callback: () => void) => () => void
  /** Rank currently shown Session History cards with Source Control AI. */
  rankSessions: (args: AiVaultRankSessionsArgs) => Promise<AiVaultRankSessionsResult>
  /** Message-level FTS5 trigram search, with rg fallback when the index is cold. */
  searchSessions: (args: AiVaultSearchSessionsArgs) => Promise<AiVaultSearchSessionsResult>
}
