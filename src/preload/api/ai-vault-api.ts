import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'
import type {
  AiVaultAgent,
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
  AiVaultHistoryReadResult,
  AiVaultHistorySearchResult
} from '../../shared/ai-vault-history-types'
import type {
  ConversationKnowledgeItem,
  ConversationKnowledgeIndexStatus,
  ConversationKnowledgeListResult,
  GenerateConversationKnowledgeRequest,
  StartConversationKnowledgeIndexRequest
} from '../../shared/conversation-knowledge-items'
import type { ExecutionHostId, ExecutionHostScope } from '../../shared/execution-host'

export type AiVaultApi = {
  /** Omitted host means this host; `all` is merged by this desktop across every enumerated host. */
  searchSessions: (
    request: AiVaultSearchRequest,
    executionHostScope?: ExecutionHostScope
  ) => Promise<AiVaultSearchResponse>
  /** Status describes one index, so it never accepts the `all` scope. */
  searchStatus: (executionHostScope?: ExecutionHostId) => Promise<AiVaultSearchStatus>
  /**
   * Turns indexing on or off on a paired Orca server and answers its status after the change.
   * Runtime hosts only: the local index follows this desktop's own settings write, SSH hosts
   * reject with `unsupported`, and a server predating the method rejects with `host-too-old`.
   */
  setSearchEnabled: (
    executionHostId: ExecutionHostId,
    enabled: boolean
  ) => Promise<AiVaultSearchStatus>
  /** Deletes and rebuilds this desktop's local search index. */
  clearSearchIndex: () => Promise<void>
  listSessions: (args?: AiVaultListArgs) => Promise<AiVaultListResult>
  searchHistory: (args: { query: string; limit?: number }) => Promise<AiVaultHistorySearchResult>
  readHistory: (args: {
    agent: AiVaultAgent
    sessionId: string
    limit?: number
  }) => Promise<AiVaultHistoryReadResult>
  enrichHistory: (args: GenerateConversationKnowledgeRequest) => Promise<ConversationKnowledgeItem>
  listKnowledge: (args?: {
    query?: string
    scopePaths?: string[]
  }) => Promise<ConversationKnowledgeListResult>
  startKnowledgeIndex: (
    args: StartConversationKnowledgeIndexRequest
  ) => Promise<ConversationKnowledgeIndexStatus>
  getKnowledgeIndexStatus: () => Promise<ConversationKnowledgeIndexStatus>
  cancelKnowledgeIndex: () => Promise<void>
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
}
