import type { SessionSearchScope } from './session-search-engine-types'
import { identifierShadowTerms } from './session-search-identifier-split'

// Match unicode61 token characters; session-search-fts5-contract.test.ts checks against SQLite.
const INDEX_TOKEN = /[\p{L}\p{N}\p{M}\p{Co}_./+-]+/gu
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by for from how i if in into is it its of on or that the this to ' +
    'was were what when where which who why with you your we my me do does did not no can could ' +
    'should would about our us they them there their has have had been being so such then than ' +
    "these those there's im ive dont"
  ).split(' ')
)
const MAX_BODY_TERMS = 48
const MAX_TERMS = 64

const LITERAL_PATTERN =
  /[A-Za-z0-9_]*[a-z][A-Z][A-Za-z0-9_]*|\b[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+\b|\b\w{2,}[._]\w{2,}\b|\b[\w.-]+\/[\w/.-]+\b|\b\w+\.(ts|tsx|js|jsx|py|rs|go|json|md|sh|yml|yaml|toml|c|cc|h|java|sql)\b|#\d{3,}|\b[A-Z]{2,6}-\d{2,}\b|[(){};=]|::|->|--\w|\b(Error|Exception|Traceback|error:|warning:)\b/
const QUOTED = /"[^"]{3,}"|'[^']{3,}'/

export type SessionSearchQueryPlan = {
  literal: boolean
  /** The query exceeded the body-term limit, so trailing tokens were dropped. */
  truncated: boolean
  /** Deduplicated OR terms, including identifier pieces. */
  terms: string[]
  /** Tokens for OR expansion; prose drops stop words unless fewer than two terms remain. */
  body: string[]
  /** Preserve stop words for phrase/AND matching because unicode61 indexes them. */
  phrase: string[]
}

export function isLiteralQuery(query: string): boolean {
  return QUOTED.test(query) || LITERAL_PATTERN.test(query)
}

export function indexTokens(query: string, limit = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = []
  for (const match of query.matchAll(INDEX_TOKEN)) {
    const token = match[0]
    // Ignore punctuation-only tokens even though FTS5 indexes them.
    if (/[\p{L}\p{N}\p{Co}]/u.test(token)) {
      out.push(token)
      if (out.length >= limit) {
        break
      }
    }
  }
  return out
}

/** Typo repair preserves the original literal mode so replanning cannot silently drop stop words. */
export function planSessionSearchQuery(
  query: string,
  literal = isLiteralQuery(query)
): SessionSearchQueryPlan {
  // Read one extra token to distinguish an exact fit from truncation.
  const overCap = indexTokens(query, MAX_BODY_TERMS + 1)
  const truncated = overCap.length > MAX_BODY_TERMS
  const raw = overCap.slice(0, MAX_BODY_TERMS)
  let body = literal ? raw : raw.filter((token) => !STOP_WORDS.has(token.toLowerCase()))
  if (body.length < 2) {
    body = raw
  }
  const terms = [...new Set(body)]
  const extra: string[] = []
  for (const term of terms) {
    for (const piece of identifierShadowTerms(term, 12)) {
      if (!terms.includes(piece) && !STOP_WORDS.has(piece) && !extra.includes(piece)) {
        extra.push(piece)
      }
    }
  }
  return {
    literal,
    truncated,
    terms: [...terms, ...extra].slice(0, MAX_TERMS),
    body: body.slice(0, MAX_BODY_TERMS),
    phrase: raw
  }
}

// Quote terms so punctuation is searched literally rather than parsed as FTS syntax.
export function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

export function phraseExpression(terms: readonly string[]): string {
  return quoteFtsTerm(terms.join(' '))
}

export function andExpression(terms: readonly string[]): string {
  return terms.map(quoteFtsTerm).join(' AND ')
}

export function orExpression(terms: readonly string[]): string {
  return terms.map(quoteFtsTerm).join(' OR ')
}

const CONVERSATION_COLUMNS = '{user_text assistant_text}'

// Parenthesize the expression so the column filter applies to every term.
export function scopedExpression(scope: SessionSearchScope, expression: string): string {
  return scope === 'all' ? expression : `${CONVERSATION_COLUMNS}: (${expression})`
}
