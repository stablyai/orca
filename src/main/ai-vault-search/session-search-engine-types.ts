import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { TranscriptMessageRole } from '../ai-vault/session-transcript-consumers'
import type { SessionSearchUnavailableFeature } from './session-search-query-schema'

// ENGINE types, deliberately not in src/shared: nothing here is a wire type.
// PR 5 owns the public contract and lifts what a caller may actually receive;
// until then a field can be added, renamed or dropped without a compat story.

export const SESSION_SEARCH_LIMIT_DEFAULT = 20
export const SESSION_SEARCH_LIMIT_MAX = 100
// Longer than this is not a query, and FTS5 pays for every term it plans.
export const SESSION_SEARCH_QUERY_MAX_LENGTH = 512

// Snippet match markers. Why doubled: single brackets are everywhere in code
// transcripts (`arr[0]`, regex classes, markdown links) and would read as
// matches; doubled ones are rare.
export const SESSION_SEARCH_SNIPPET_MARK_OPEN = '[['
export const SESSION_SEARCH_SNIPPET_MARK_CLOSE = ']]'

/**
 * Which corpus answers the query.
 *
 * - `conversation`: user and assistant turns only, from `conversation_fts`.
 * - `all`: those turns plus tool calls and tool output, and the identifier
 *   shadow column, from `messages_fts`.
 *
 * The engine searches exactly the scope it is given. Switching corpus as the
 * user types is a UI policy and lives in the panel (PR 7); an engine that
 * second-guessed the scope would make a result impossible to reproduce from
 * its own request.
 */
export type SessionSearchScope = 'conversation' | 'all'

export type SessionSearchSort = 'relevance' | 'newest'

export type SessionSearchFilters = {
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

/**
 * How the query was executed. Diagnostics, not an answer: PR 5 decides which of
 * these a caller ever sees (the reviewer's F5/F7 want them behind `debug`).
 */
export type SessionSearchPlannerReport = {
  route: SessionSearchRoute
  /**
   * The whole body the repaired plan searched, in query order, when any term
   * was changed. Not just the corrected terms: a caller rendering "searched
   * for" needs the query it actually ran, and a repair never drops a term the
   * original kept. A corrected term carries the index's own spelling, which the
   * tokenizer has case-folded; untouched terms keep the case they were typed in.
   */
  repairedTerms?: string[]
  /** The corpus the route ran against; today always the requested scope. */
  tier: SessionSearchScope
}

/**
 * Where a source stands according to the index's own `files` table. The query
 * path never stats a transcript, so it can report that the index has a live
 * file record for a session or that it has none, and never that a source is
 * gone: only a proven deletion may claim `missing`, and proving one is the
 * indexer's job (docs/reference/ssh-execution-boundary.md).
 */
export type SessionSearchSourcePresence = 'present' | 'unverifiable'

export type SessionSearchEvidence = {
  role: TranscriptMessageRole
  timestamp: string | null
  /** FTS5 snippet with the matched terms wrapped in `[[` `]]`. */
  snippet: string
  /** The snippet hit the engine's per-hit ceiling and was cut. */
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
  /** Null when this page is the last one. */
  cursor: string | null
  hasMore: boolean
}

export type SessionSearchTruncation = {
  /**
   * Ranking saw only the first `sessionCandidateLimit` sessions, so a session
   * past that cut cannot appear on any page of this query.
   */
  candidates: boolean
  /** Hits on this page whose snippet was cut. */
  snippets: number
  /**
   * The query itself was cut before it was searched: past the length ceiling,
   * or past the number of terms the planner will plan. The terms that survived
   * were searched in full, so a hit is still a hit; a miss is not proof of
   * absence.
   */
  query: boolean
}

export type SessionSearchResponse = {
  hits: SessionSearchHit[]
  /**
   * Engine features the index on disk cannot serve, empty on a current index.
   * A route ladder missing its repair rung still answers; saying so is what
   * keeps the answer honest.
   */
  unavailable: readonly SessionSearchUnavailableFeature[]
  planner: SessionSearchPlannerReport
  page: SessionSearchPage
  truncated: SessionSearchTruncation
  /** The index snapshot these hits came from; a cursor is only valid within it. */
  generation: number
  durationMs: number
}

export function resolveSessionSearchLimit(limit: number | undefined): number {
  // Why clamped here and not at the caller: a non-positive limit becomes
  // `slice(0, -1)`, which silently drops the last hit of every page.
  const requested = Number.isInteger(limit) ? (limit as number) : SESSION_SEARCH_LIMIT_DEFAULT
  return Math.min(Math.max(1, requested), SESSION_SEARCH_LIMIT_MAX)
}
