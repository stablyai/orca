import { sessionSearchPathKey } from './session-search-path-key'
import type { AiVaultSearchArgs } from '../../shared/ai-vault-search-types'
import type { AiVaultSearchQuerySplit } from '../../shared/ai-vault-search-query-operators'
import { isRuntimePathAbsolute } from '../../shared/cross-platform-path'

/** SQL fragments for the `sessions` WHERE clause; every condition is ANDed. */
export type SessionRowFilter = {
  conditions: string[]
  values: string[]
}

// Stored identity preserves execution-host case and WSL distro semantics.
const CWD = 'cwd_key'
// Why: SQLite has no basename(). `rtrim(p, <p minus its separators>)` peels the
// last segment off, leaving the parent prefix to delete out of p.
const CWD_BASENAME = `replace(${CWD}, rtrim(${CWD}, replace(${CWD}, '/', '')), '')`

export function sessionRowFilter(
  args: AiVaultSearchArgs,
  split: AiVaultSearchQuerySplit
): SessionRowFilter {
  const filter: SessionRowFilter = { conditions: [], values: [] }
  if (args.agents && args.agents.length > 0) {
    filter.conditions.push(`agent IN (${args.agents.map(() => '?').join(',')})`)
    filter.values.push(...args.agents)
  }
  if (args.since) {
    filter.conditions.push('updated_at >= ?')
    filter.values.push(args.since)
  }
  if (args.scopePaths && args.scopePaths.length > 0) {
    filter.conditions.push(
      `(${args.scopePaths.map(() => `(${CWD} = ? OR substr(${CWD}, 1, length(?)) = ?)`).join(' OR ')})`
    )
    for (const scope of args.scopePaths) {
      // Literal prefixes keep `%` and `_` in folder names from widening scope.
      const normalized = sessionSearchPathKey(scope)
      filter.values.push(normalized, `${normalized}/`, `${normalized}/`)
    }
  }
  // Operators narrow, never widen: each one is its own ANDed condition on top
  // of whatever scope the caller already asked for.
  for (const term of split.pathTerms) {
    addPathTerm(filter, term)
  }
  for (const term of split.repoTerms) {
    // Why: a folder workspace has no repo name beyond its own folder, so the
    // last segment of cwd is the only honest local proxy for `repo:`.
    filter.conditions.push(`lower(${CWD_BASENAME}) LIKE ? ESCAPE '\\'`)
    filter.values.push(likeContains(term))
  }
  return filter
}

function addPathTerm(filter: SessionRowFilter, term: string): void {
  const normalized = normalizeCwdTerm(term)
  if (!normalized) {
    return
  }
  if (isRuntimePathAbsolute(term)) {
    const key = sessionSearchPathKey(term)
    filter.conditions.push(`(${CWD} = ? OR substr(${CWD}, 1, length(?)) = ?)`)
    filter.values.push(key, `${key}/`, `${key}/`)
    return
  }
  filter.conditions.push(`lower(${CWD}) LIKE ? ESCAPE '\\'`)
  filter.values.push(likeContains(normalized))
}

function normalizeCwdTerm(term: string): string {
  return term.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function likeContains(value: string): string {
  return `%${escapeLike(value)}%`
}

// LIKE wildcards inside a user-typed term are literal text, not a pattern.
function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, '\\$&')
}
