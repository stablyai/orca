import type { SessionSearchProjectOwnership } from './session-search-project-ownership'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { TranscriptMessageRole } from '../ai-vault/session-transcript-consumers'

export {
  SESSION_SEARCH_LIMIT_DEFAULT,
  SESSION_SEARCH_LIMIT_MAX,
  resolveSessionSearchLimit
} from '../../shared/ai-vault-search-limit'
// Bound planning cost for long queries, including single-token pastes.
export const SESSION_SEARCH_QUERY_MAX_LENGTH = 512

// Double brackets reduce collisions with code syntax in transcript snippets.
export const SESSION_SEARCH_SNIPPET_MARK_OPEN = '[['
export const SESSION_SEARCH_SNIPPET_MARK_CLOSE = ']]'

/** Conversation searches user/assistant columns; all also searches tools and identifier tokens. */
export type SessionSearchScope = 'conversation' | 'all'

export type SessionSearchSort = 'relevance' | 'newest'

export type SessionSearchFilters = {
  ownership?: SessionSearchProjectOwnership
  agents?: readonly AiVaultAgent[]
  /** Only sessions whose cwd is that path or inside it. */
  scopePaths?: readonly string[]
  /** ISO timestamp; only sessions updated at or after it. */
  since?: string
  sort?: SessionSearchSort
}

export type SessionSearchRequest = {
  query: string
  /** Default `all`. */
  scope?: SessionSearchScope
  limit?: number
  /** From a previous response's `page.cursor`; only valid in its own generation. */
  cursor?: string
  filters?: SessionSearchFilters
}

export type SessionSearchRoute = 'phrase' | 'and' | 'or' | 'typo+phrase' | 'typo+and' | 'typo+or'

export type SessionSearchPlannerReport = {
  route: SessionSearchRoute
  /** Full searched term sequence; repaired terms use index spelling, untouched terms retain input case. */
  repairedTerms?: string[]
  tier: SessionSearchScope
}

/** Index evidence only: search never stats transcripts, so a missing file row means unverifiable. */
export type SessionSearchSourcePresence = 'present' | 'unverifiable'

export type SessionSearchEvidence = {
  role: TranscriptMessageRole
  timestamp: string | null
  /** FTS5 snippet with the matched terms wrapped in `[[` `]]`. */
  snippet: string
  snippetTruncated?: boolean
}

export type SessionSearchHit = {
  agent: AiVaultAgent
  sessionId: string
  filePath: string
  codexHome: string | null
  title: string
  cwd: string | null
  branch: string | null
  updatedAt: string | null
  messageCount: number
  resumeCommand: string
  score: number
  /** Sessions folded into this hit (forks sharing an opening prefix); absent when unique. */
  duplicateCount?: number
  source: SessionSearchSourcePresence
  /** Null when the operators alone put this session on the page, with no text match. */
  evidence: SessionSearchEvidence | null
}

export type SessionSearchPage = {
  cursor: string | null
  hasMore: boolean
}

export type SessionSearchTruncation = {
  /** Retrieval hit a candidate or scan limit; some matching sessions may be absent from every page. */
  candidates: boolean
  /** Hits on this page whose snippet was cut. */
  snippets: number
  /** Query length or term limits dropped input; a miss may omit matches for the dropped text. */
  query: boolean
}

export type SessionSearchResponse = {
  hits: SessionSearchHit[]
  planner: SessionSearchPlannerReport
  page: SessionSearchPage
  truncated: SessionSearchTruncation
  /** The index snapshot these hits came from; a cursor is only valid within it. */
  generation: number
  durationMs: number
}
