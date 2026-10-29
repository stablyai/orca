import type { SessionSearchScope } from './session-search-engine-types'
import {
  andExpression,
  scopedExpression,
  type SessionSearchQueryPlan
} from './session-search-query-planner'

// Shortest run the trigram tokenizer can index; shorter ones are scanned with LIKE.
const TRIGRAM_MIN_CHARS = 3
const CONVERSATION_COLUMNS = ['user_text', 'assistant_text']
const ALL_COLUMNS = [...CONVERSATION_COLUMNS, 'tool_text']

export type CjkMatch = {
  /** Conditions to AND into a `FROM messages_cjk_fts JOIN messages m` statement. */
  conditions: string[]
  /** Values for the conditions' placeholders, in order. */
  params: string[]
  /** Ranks by bm25 when a trigram MATCH ran; LIKE-only queries have no relevance signal. */
  score: string
}

export function cjkColumns(scope: SessionSearchScope): string[] {
  return scope === 'all' ? ALL_COLUMNS : CONVERSATION_COLUMNS
}

/** Every CJK run of the query must occur as a substring; the query's other tokens must match the main index. */
export function planCjkMatch(plan: SessionSearchQueryPlan, scope: SessionSearchScope): CjkMatch {
  const conditions: string[] = []
  const params: string[] = []
  const columns = cjkColumns(scope)
  const long = plan.cjkRuns.filter((run) => [...run].length >= TRIGRAM_MIN_CHARS)
  if (long.length > 0) {
    conditions.push('messages_cjk_fts MATCH ?')
    params.push(scopedExpression(scope, andExpression(long)))
  }
  for (const run of plan.cjkRuns.filter((candidate) => [...candidate].length < TRIGRAM_MIN_CHARS)) {
    conditions.push(
      `(${columns.map((column) => `messages_cjk_fts.${column} LIKE ?`).join(' OR ')})`
    )
    params.push(...columns.map(() => `%${run}%`))
  }
  if (plan.cjkRest.length > 0) {
    conditions.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)')
    params.push(scopedExpression(scope, andExpression(plan.cjkRest)))
  }
  const weights = scope === 'all' ? '3.0, 2.0, 1.0' : '3.0, 2.0, 0.0'
  return {
    conditions,
    params,
    score: long.length > 0 ? `-bm25(messages_cjk_fts, ${weights})` : '1.0'
  }
}
