import { identifierShadowTerms } from './session-search-identifier-split'

// Tokens exactly as the unicode61 tokenizer with `_ . - / +` tokenchars emits them.
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

// A query that quotes something from a transcript: camelCase, SCREAMING_SNAKE,
// a dotted or snake_case name, a path, a filename, a PR number, a ticket, code
// punctuation, or an error word.
const LITERAL_SHAPE =
  /[A-Za-z0-9_]*[a-z][A-Z][A-Za-z0-9_]*|\b[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+\b|\b\w{2,}[._]\w{2,}\b|\b[\w.-]+\/[\w/.-]+\b|\b\w+\.(ts|tsx|js|jsx|py|rs|go|json|md|sh|yml|yaml|toml|c|cc|h|java|sql)\b|#\d{3,}|\b[A-Z]{2,6}-\d{2,}\b|[(){};=]|::|->|--\w|\b(Error|Exception|Traceback|error:|warning:)\b/
const QUOTED = /"[^"]{3,}"|'[^']{3,}'/

export type SessionSearchQueryPlan = {
  literal: boolean
  /** Deduplicated index-faithful terms for the OR fallback, incl. identifier pieces. */
  terms: string[]
  /** Query-order tokens minus stop words: the phrase / AND candidate. */
  body: string[]
}

export function isLiteralQuery(query: string): boolean {
  return QUOTED.test(query) || LITERAL_SHAPE.test(query)
}

/**
 * The tokenizer contract, unfolded: the same boundaries FTS5 draws for
 * `unicode61 tokenchars '_.-/+'`. Pinned against real `fts5vocab` output in
 * session-search-fts5-contract.test.ts, which is what makes it safe to plan a
 * query without asking SQLite.
 */
export function indexTokens(query: string, limit = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = []
  for (const match of query.matchAll(INDEX_TOKEN)) {
    const token = match[0]
    // Separators alone (`--`, `...`) are a token to FTS5 but never a search term.
    if (/[\p{L}\p{N}\p{Co}]/u.test(token)) {
      out.push(token)
      if (out.length >= limit) {
        break
      }
    }
  }
  return out
}

/**
 * `literal` overrides the shape test. Typo repair re-plans the query it
 * corrected, and a corrected spelling can look like ordinary prose even though
 * what was typed was a literal: `parseJsonn(the, data)` has the punctuation that
 * makes it literal, `parsejson the data` does not. Without the override the
 * re-plan would drop `the` as a stop word, so the repaired query would search
 * for less than the original asked for and `repairedTerms` would report a body
 * the user never typed.
 */
export function planSessionSearchQuery(
  query: string,
  literal = isLiteralQuery(query)
): SessionSearchQueryPlan {
  const raw = indexTokens(query, MAX_BODY_TERMS)
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
    terms: [...terms, ...extra].slice(0, MAX_TERMS),
    body: body.slice(0, MAX_BODY_TERMS)
  }
}

// Why: `cli.mjs`, `foo-bar`, and `C++` are all FTS5 syntax errors unquoted.
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
