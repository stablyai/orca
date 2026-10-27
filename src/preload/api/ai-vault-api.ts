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
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type { ExecutionHostId, ExecutionHostScope } from '../../shared/execution-host'
import type {
  AiVaultScanProgress,
  AiVaultScanProgressUpdate
} from '../../shared/ai-vault-scan-progress'

export type AiVaultApi = {
  /** Omitted host means this host; `all` is merged by this desktop across every enumerated host. */
  searchSessions: (
    request: AiVaultSearchRequest,
    executionHostScope?: ExecutionHostScope,
    isActive?: () => boolean
  ) => Promise<AiVaultSearchResponse>
  /** Status describes one index, so it never accepts the `all` scope. */
  searchStatus: (executionHostScope?: ExecutionHostId) => Promise<AiVaultSearchStatus>
  /** Paired servers only; SSH rejects as unsupported, older servers as host-too-old. */
  setSearchEnabled: (
    executionHostId: ExecutionHostId,
    enabled: boolean
  ) => Promise<AiVaultSearchStatus>
  /** Rebuilds the local index after deletion. */
  clearSearchIndex: () => Promise<void>
  listSessions: (args?: AiVaultListArgs) => Promise<AiVaultListResult>
  resolveSessionTitles: (args: AiVaultSessionTitlesArgs) => Promise<AiVaultSessionTitlesResult>
  cancelListSessions: (args: { requestToken: string }) => Promise<void>
  prepareSessionResume: (
    args: AiVaultPrepareSessionResumeRequest
  ) => Promise<AiVaultPrepareSessionResumeResult>
  listSubagentSessions: (args: AiVaultSubagentListArgs) => Promise<AiVaultSubagentListResult>
  getFirstUserPrompt: (args: AiVaultFirstUserPromptArgs) => Promise<AiVaultFirstUserPromptResult>
  /** Moves a deletable session's transcript to the OS trash; local sessions only. */
  deleteSession: (args: AiVaultDeleteSessionArgs) => Promise<AiVaultDeleteSessionResult>
  /** Fires when any app window regains OS focus. */
  onWindowFocused: (callback: () => void) => () => void
  /** The local scan entry for a request key, if it is still retained. */
  getScanProgress: (scanKey: string) => Promise<AiVaultScanProgress | null>
  onScanProgress: (callback: (update: AiVaultScanProgressUpdate) => void) => () => void
}
