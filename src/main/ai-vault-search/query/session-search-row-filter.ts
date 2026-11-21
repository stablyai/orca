import { cwdKey } from '../storage/session-search-file-records'
import type { SessionSearchFilters } from './session-search-engine-types'

type SessionRowPredicate = {
  conditions: string[]
  values: (string | number)[]
}

/** Population SQL and point eligibility share all predicates and scope normalization. */
export type SessionRowFilter = SessionRowPredicate & {
  candidate: SessionRowPredicate
  matchesScope: (key: string | null) => boolean
}

// Use the sidebar’s cwd identity so indexed sessions and scopes share path normalization.
const CWD = 'cwd_key'

/** Keep repo:/path: in the sidebar’s JS matcher; SQL LIKE differs on Unicode and path semantics. */
export function sessionRowFilter(
  filters: SessionSearchFilters,
  cutoffMs: number | null = null
): SessionRowFilter {
  const candidate: SessionRowPredicate = { conditions: [], values: [] }
  if (cutoffMs !== null) {
    candidate.conditions.push(
      'EXISTS (SELECT 1 FROM files WHERE session_row_id = sessions.id AND mtime_ms >= ?)'
    )
    candidate.values.push(cutoffMs)
  }
  if (filters.agents && filters.agents.length > 0) {
    candidate.conditions.push(`agent IN (${filters.agents.map(() => '?').join(',')})`)
    candidate.values.push(...filters.agents)
  }
  if (filters.since) {
    candidate.conditions.push('updated_at >= ?')
    candidate.values.push(filters.since)
  }
  const filter: SessionRowFilter = {
    conditions: [...candidate.conditions],
    values: [...candidate.values],
    candidate,
    matchesScope: () => true
  }
  if (filters.scopePaths && filters.scopePaths.length > 0) {
    // Unkeyable scopes must not widen a scoped query to every session.
    const keys = filters.scopePaths
      .map(cwdKey)
      .filter((key) => key !== null)
      .map((key) => key.toWellFormed())
    filter.matchesScope = scopeMatcher(keys)
    if (keys.length === 0) {
      filter.conditions.push('0 = 1')
    } else {
      filter.conditions.push(SCOPE_CONDITION)
      filter.values.push(JSON.stringify(keys.map(scopeRange)))
    }
  }
  return filter
}

// Why: population queries must seek the scope once, before counting accepted rows for LIMIT.
const SCOPE_CONDITION = `id IN (
  SELECT scoped.id FROM json_each(?) AS scope JOIN sessions AS scoped
    ON scoped.${CWD} = scope.value ->> 0
    OR (scoped.${CWD} >= scope.value ->> 1 AND scoped.${CWD} < scope.value ->> 2)
)`

function scopeMatcher(keys: readonly string[]): SessionRowFilter['matchesScope'] {
  const exact = new Set(keys)
  const children = new Set(keys.map(childPrefix))
  return (key) => {
    if (key === null) {
      return false
    }
    if (exact.has(key)) {
      return true
    }
    // Why: ancestor-prefix lookups scale with this path's depth, not the number of scopes.
    for (let slash = key.indexOf('/'); slash !== -1; slash = key.indexOf('/', slash + 1)) {
      if (children.has(key.slice(0, slash + 1))) {
        return true
      }
    }
    return false
  }
}

function childPrefix(key: string): string {
  return key.endsWith('/') ? key : `${key}/`
}

function scopeRange(scopeKey: string): [string, string, string] {
  const children = childPrefix(scopeKey)
  return [scopeKey, children, nextAfterPrefix(children)]
}

/** Upper bound for every string starting with prefix. */
function nextAfterPrefix(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}
