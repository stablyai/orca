import type { PRCheckDetail } from '../../shared/types'

// GitHub keeps every check run attached to a commit, so a re-run (e.g. after a
// fail-fast CANCELLED, or a PR-edit re-trigger) leaves the superseded run in
// statusCheckRollup alongside the fresh one. `gh pr checks` collapses to the
// latest run per name; these helpers do the same so a stale CANCELLED/FAILURE
// no longer marks a PR as failing after later runs turn green.

type RollupEntryLike = {
  name?: unknown
  context?: unknown
  workflowName?: unknown
  startedAt?: unknown
  completedAt?: unknown
}

// A check-run name still holding a literal `${{ … }}` expression is a GitHub
// Actions matrix skeleton that was cancelled before it expanded into real jobs
// (the expanded siblings run under substituted names). GitHub excludes it from
// the merge rollup entirely; a genuine run never has an unrendered expression.
function isUnexpandedMatrixPlaceholder(name: string): boolean {
  return name.includes('${{')
}

function rollupEntryKey(entry: RollupEntryLike): string | null {
  const name =
    typeof entry.name === 'string' && entry.name
      ? entry.name
      : typeof entry.context === 'string' && entry.context
        ? entry.context
        : null
  if (!name) {
    return null
  }
  // Scope by workflow so distinct workflows sharing a job name stay separate;
  // re-runs of the same workflow share it and collapse.
  const workflow = typeof entry.workflowName === 'string' ? entry.workflowName : ''
  return `${workflow} ${name}`
}

// completedAt (else startedAt) as an ISO-8601 UTC string sorts lexicographically
// by recency; missing timestamps sort earliest so a timestamped run wins.
function rollupEntryRecency(entry: RollupEntryLike): string {
  if (typeof entry.completedAt === 'string' && entry.completedAt) {
    return entry.completedAt
  }
  if (typeof entry.startedAt === 'string' && entry.startedAt) {
    return entry.startedAt
  }
  return ''
}

/**
 * Collapse a raw statusCheckRollup array to the latest run per (workflow, name).
 * Entries without a resolvable name are kept as-is (can't be deduped safely).
 */
export function latestRollupEntriesByName(rollup: readonly unknown[]): unknown[] {
  const latestByKey = new Map<string, { entry: unknown; recency: string }>()
  const unkeyed: unknown[] = []
  for (const raw of rollup) {
    if (typeof raw !== 'object' || raw === null) {
      unkeyed.push(raw)
      continue
    }
    const entry = raw as RollupEntryLike
    const key = rollupEntryKey(entry)
    if (key === null) {
      unkeyed.push(raw)
      continue
    }
    // Drop superseded matrix skeletons (name ends the space with an unexpanded expression).
    if (isUnexpandedMatrixPlaceholder(key)) {
      continue
    }
    const recency = rollupEntryRecency(entry)
    const existing = latestByKey.get(key)
    // >= keeps the later-seen entry on ties, matching input order for equal timestamps.
    if (!existing || recency >= existing.recency) {
      latestByKey.set(key, { entry: raw, recency })
    }
  }
  return [...unkeyed, ...[...latestByKey.values()].map((v) => v.entry)]
}

/**
 * Collapse mapped PRCheckDetail rows to the latest run per name. The GraphQL/REST
 * check queries carry no timestamps, but a re-run gets a higher checkRunId, so the
 * max id is the newest run. Rows without a checkRunId (legacy status contexts) are
 * unique by name already and kept as-is.
 */
export function latestCheckDetailsByName(checks: readonly PRCheckDetail[]): PRCheckDetail[] {
  const latestByName = new Map<string, PRCheckDetail>()
  const order: string[] = []
  for (const check of checks) {
    if (isUnexpandedMatrixPlaceholder(check.name)) {
      continue
    }
    const existing = latestByName.get(check.name)
    if (!existing) {
      latestByName.set(check.name, check)
      order.push(check.name)
      continue
    }
    const existingId = existing.checkRunId ?? -Infinity
    const nextId = check.checkRunId ?? -Infinity
    if (nextId >= existingId) {
      latestByName.set(check.name, check)
    }
  }
  return order.map((name) => latestByName.get(name) as PRCheckDetail)
}
