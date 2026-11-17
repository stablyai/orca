import type {
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from '../../../../native-chat/transcript-history/opencode/transcript-opencode-sqlite-query'
import type {
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { SqliteSessionAgent } from '../../../../../shared/agent-session/lifecycle/provider-handles/opencode-sqlite-session-path'
import type { SessionFileCandidate } from '../../../session-scanner-types'
import type { TranscriptMessage } from '../../../transcripts/session-transcript-consumers'

/** Session stores the reader serves besides OpenCode 1; absent means OpenCode 1. */
export type SqliteReaderAgent = Exclude<SqliteSessionAgent, 'opencode'>

export type OpenCodeSqliteListRequest = {
  id: number
  kind: 'list'
  dbPaths: readonly string[]
  limit: number | null
  agent?: SqliteReaderAgent
  /** Lists only sessions whose directory is in scope (Hermes: the newest plus those in scope); an older reader ignores it and lists unfiltered. */
  scopePaths?: readonly string[]
}

export type OpenCodeSqliteParseRequest = {
  id: number
  kind: 'parse'
  fullFirstUserPrompt?: boolean
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  agent?: SqliteReaderAgent
}

// Separate capture requests keep full-transcript response types distinct from preview-only parses.
export type OpenCodeSqliteCaptureRequest = {
  id: number
  kind: 'capture'
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  agent?: SqliteReaderAgent
}

export type OpenCodeNativeChatReadRequest = {
  id: number
  /** `hermes-history`: a Hermes conversation as chat messages, for a chat that takes it over. */
  kind: 'native-page' | 'native-signal' | 'hermes-history'
  dbPath: string
  sessionId: string
  limit?: number
  beforeMessageRowId?: number
  /** When 'zcode', reads apply ZCode's hidden-transcript filter. */
  agent?: 'zcode'
}

export type OpenCodeForkCoverageRequest = {
  id: number
  kind: 'fork-coverage'
  sourceSessionId: string
  dbPath: string
  sessionId: string
}

export type OpenCodeNativeChatReadValue =
  | OpenCodeTranscriptPage
  | OpenCodeTranscriptSignal
  | NativeChatMessage[]
  | null

export type OpenCodeSqliteWorkerRequest = (
  | OpenCodeSqliteListRequest
  | OpenCodeSqliteParseRequest
  | OpenCodeSqliteCaptureRequest
  | OpenCodeNativeChatReadRequest
  | OpenCodeForkCoverageRequest
) & { timeoutMs?: number }

export type OpenCodeSqliteListValue = {
  candidates: SessionFileCandidate[]
  issues: AiVaultScanIssue[]
}

export type OpenCodeSqliteCaptureValue = {
  session: AiVaultSession | null
  messages: TranscriptMessage[]
}

export type OpenCodeSqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
