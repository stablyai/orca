import { cwdKey } from './session-search-file-records'
import type { SessionSearchFilters } from './session-search-engine-types'

/** SQL fragments for the `sessions` WHERE clause; every condition is ANDed. */
export type SessionRowFilter = {
  conditions: string[]
  values: (string | number)[]
}

// Stored identity: `cwdKey` is the sidebar's `folderGroupKey` without its prefix,
// so a scope term and an indexed session are keyed by one function, never two.
const CWD = 'cwd_key'

/**
 * The narrowings SQL can express exactly, in one place, so retrieval, the
 * operator-only page and the session load cannot drift apart. These conditions
 * run over `sessions` itself. Reachability is not here and is not a condition:
 * it is the INNER JOIN to `sessions` that every retrieval carries, which is
 * what makes a message row a purge has not reclaimed yet unreadable.
 *
 * `repo:` and `path:` are deliberately absent. What they mean is the predicate
 * the sessions panel applies (`matchesAiVaultQueryOperators`), and SQL cannot
 * express it: LIKE folds ASCII and nothing else, so `path:CAFÉ` would miss
 * `café`; `path:` searches the transcript path as well as the working
 * directory, so `path:jsonl` would miss every session; and `repo:` compares the
 * last two path segments, not one. A second spelling that came close would be a
 * query meaning different things in the list and in the index, so the engine
 * applies the panel's own predicate over the rows it retrieves instead.
 *
 * `scopePaths` stays here because it is exact: a prefix range over the key
 * `cwdKey` produces, which folds exactly where the execution host folds —
 * Windows drives, never a POSIX directory name.
 */
export function sessionRowFilter(
  filters: SessionSearchFilters,
  cutoffMs: number | null = null
): SessionRowFilter {
  const filter: SessionRowFilter = { conditions: [], values: [] }
  if (cutoffMs !== null) {
    filter.conditions.push('id IN (SELECT session_row_id FROM files WHERE mtime_ms >= ?)')
    filter.values.push(cutoffMs)
  }
  if (filters.agents && filters.agents.length > 0) {
    filter.conditions.push(`agent IN (${filters.agents.map(() => '?').join(',')})`)
    filter.values.push(...filters.agents)
  }
  if (filters.since) {
    filter.conditions.push('updated_at >= ?')
    filter.values.push(filters.since)
  }
  if (filters.scopePaths && filters.scopePaths.length > 0) {
    // Several scopes mean any of them; every other narrowing is ANDed on.
    const present = filters.scopePaths
      .map((scope) => scopeCondition(filter, scope))
      .filter((condition) => condition !== null)
    // Every scope unkeyable still means a scope, so it narrows to nothing;
    // pushing no condition would widen the search to every session instead.
    filter.conditions.push(present.length > 0 ? `(${present.join(' OR ')})` : '0 = 1')
  }
  return filter
}

/** A scope the caller could not key is a scope nothing is inside of. */
function scopeCondition(filter: SessionRowFilter, scope: string): string | null {
  const key = cwdKey(scope)
  return key === null ? null : insideCondition(filter, key)
}

/**
 * `key` itself, or anything below it. Why a half-open range and not
 * `substr(key, 1, length(?)) = ?`: only `>=`/`<` can seek `sessions_cwd_key`;
 * the substr form scans it. The bound is the child prefix with its last byte
 * incremented, so it stops at the end of that prefix and nowhere else. The two
 * arms cannot merge: one range over the bare key would also swallow a sibling
 * like `/work/app-other`. No wildcards, so `%`/`_` in a folder name are literal.
 *
 * The filesystem root is the one key that already ends in a separator, and
 * appending a second one would bound the range at `//`, which sorts below every
 * real child; `cwdKey` keeps it as `/` for exactly this reason.
 */
function insideCondition(filter: SessionRowFilter, key: string): string {
  const children = key.endsWith('/') ? key : `${key}/`
  filter.values.push(key, children, nextAfterPrefix(children))
  return `(${CWD} = ? OR (${CWD} >= ? AND ${CWD} < ?))`
}

/** The first string that sorts after every string starting with `prefix`. */
function nextAfterPrefix(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}
