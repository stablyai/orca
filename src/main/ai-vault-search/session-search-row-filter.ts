import { cwdKey } from './session-search-file-records'
import type { SessionSearchFilters } from './session-search-engine-types'

/** ANDed conditions and bound values for the sessions WHERE clause. */
export type SessionRowFilter = {
  conditions: string[]
  values: (string | number)[]
}

// Use the sidebar’s cwd identity so indexed sessions and scopes share path normalization.
const CWD = 'cwd_key'

/** Keep repo:/path: in the sidebar’s JS matcher; SQL LIKE differs on Unicode and path semantics. */
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
    // Unkeyable scopes must not widen a scoped query to every session.
    const keys = filters.scopePaths.map(cwdKey).filter((key) => key !== null)
    if (keys.length === 0) {
      filter.conditions.push('0 = 1')
    } else {
      filter.conditions.push(SCOPE_CONDITION)
      filter.values.push(JSON.stringify(keys.map(scopeRange)))
    }
  }
  if (filters.ownership) {
    filter.conditions.push(`id IN (
      SELECT scoped.id FROM json_each(?) AS scope JOIN sessions AS scoped
      ON scoped.cwd_key >= scope.value ->> 0 AND scoped.cwd_key < scope.value ->> 1
      WHERE canonical_project_owns(scoped.cwd_key, scoped.file_path)
    )`)
    filter.values.push(JSON.stringify(filters.ownership.ranges))
  }
  return filter
}

// One JSON parameter avoids OR-depth limits; exact-key and child-prefix ranges seek sessions_cwd_key.
const SCOPE_CONDITION = `id IN (
  SELECT scoped.id FROM json_each(?) AS scope JOIN sessions AS scoped
    ON scoped.${CWD} = scope.value ->> 0
    OR (scoped.${CWD} >= scope.value ->> 1 AND scoped.${CWD} < scope.value ->> 2)
)`

function scopeRange(scopeKey: string): [string, string, string] {
  // Match SQLite’s U+FFFD encoding of lone surrogates before serializing keys through JSON.
  const key = scopeKey.toWellFormed()
  const children = key.endsWith('/') ? key : `${key}/`
  return [key, children, nextAfterPrefix(children)]
}

/** Upper bound for every string starting with prefix. */
function nextAfterPrefix(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}
