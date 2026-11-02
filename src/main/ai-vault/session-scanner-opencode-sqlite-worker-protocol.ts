import type {
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from '../native-chat/transcript-opencode-sqlite-query'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import type { TranscriptMessage } from './session-transcript-consumers'

export type OpenCodeSqliteListRequest = {
  id: number
  kind: 'list'
  dbPaths: readonly string[]
  limit: number | null
  agent?: 'opencode2' | 'zcode'
  selectedSessionId?: string
  /** Lists only sessions whose directory is in scope; an older reader ignores it and lists unfiltered. */
  scopePaths?: readonly string[]
}

export type OpenCodeSqliteParseRequest = {
  id: number
  kind: 'parse'
  fullFirstUserPrompt?: boolean
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  agent?: 'opencode2' | 'zcode'
}

// Separate capture requests keep full-transcript response types distinct from preview-only parses.
export type OpenCodeSqliteCaptureRequest = {
  id: number
  kind: 'capture'
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  agent?: 'opencode2' | 'zcode'
}

export type OpenCodeNativeChatReadRequest = {
  id: number
  kind: 'native-page' | 'native-signal'
  dbPath: string
  sessionId: string
  limit?: number
  beforeMessageRowId?: number
  /** When 'zcode', reads apply ZCode's hidden-transcript filter. */
  agent?: 'zcode'
}

export type OpenCodeNativeChatReadValue = OpenCodeTranscriptPage | OpenCodeTranscriptSignal | null

export type OpenCodeSqliteWorkerRequest = (
  | OpenCodeSqliteListRequest
  | OpenCodeSqliteParseRequest
  | OpenCodeSqliteCaptureRequest
  | OpenCodeNativeChatReadRequest
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
