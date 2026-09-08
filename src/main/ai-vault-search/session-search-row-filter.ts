import { sessionSearchPathKey } from './session-search-path-key'
import type { AiVaultSearchArgs } from '../../shared/ai-vault-search-types'
import type { AiVaultSearchQuerySplit } from '../../shared/ai-vault-search-query-operators'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathSeparators
} from '../../shared/cross-platform-path'

/** SQL fragments for the `sessions` WHERE clause; every condition is ANDed. */
export type SessionRowFilter = {
  conditions: string[]
  values: (string | number)[]
}

// Stored identity preserves execution-host case and WSL distro semantics.
const CWD = 'cwd_key'
// Why: SQLite has no basename(). `rtrim(p, <p minus its separators>)` peels the
// last segment off, leaving the parent prefix to delete out of p.
const CWD_BASENAME = `replace(${CWD}, rtrim(${CWD}, replace(${CWD}, '/', '')), '')`

/**
 * Every caller-supplied narrowing in one place, so `match`, `recent`, and
 * `loadSessions` cannot drift apart. Row visibility is not here: it belongs to
 * the `visible_sessions` / `visible_messages` views these conditions run over.
 *
 * Case rule, one for the whole file: a comparison that claims *identity*
 * (`scopePaths`, an absolute `path:`) compares the stored key as-is, so it folds
 * exactly where the execution host folds — Windows drives and the WSL distro
 * segment, never a POSIX directory name. A comparison that is only a *substring
 * probe* (a relative `path:`, any `repo:`) uses LIKE, which folds ASCII and
 * nothing else; SQLite has no Unicode fold, and `lower()` would fold ASCII twice
 * while still missing `É`, so it is not used.
 */
export function sessionRowFilter(
  args: AiVaultSearchArgs,
  split: AiVaultSearchQuerySplit,
  cutoffMs: number | null = null
): SessionRowFilter {
  const filter: SessionRowFilter = { conditions: [], values: [] }
  if (cutoffMs !== null) {
    filter.conditions.push('id IN (SELECT session_row_id FROM files WHERE mtime_ms >= ?)')
    filter.values.push(cutoffMs)
  }
  if (args.agents && args.agents.length > 0) {
    filter.conditions.push(`agent IN (${args.agents.map(() => '?').join(',')})`)
    filter.values.push(...args.agents)
  }
  if (args.since) {
    filter.conditions.push('updated_at >= ?')
    filter.values.push(args.since)
  }
  if (args.scopePaths && args.scopePaths.length > 0) {
    addGroup(
      filter,
      args.scopePaths.map((scope) => insideCondition(filter, sessionSearchPathKey(scope)))
    )
  }
  // Operators narrow the caller's scope, never widen it, and follow the usual
  // qualifier semantics: OR within one key, AND across keys, so `path:a path:b`
  // means either while `repo:x path:a` means both.
  addGroup(
    filter,
    split.pathTerms.map((term) => pathTermCondition(filter, term))
  )
  addGroup(
    filter,
    // Why: a folder workspace has no repo name beyond its own folder, so the
    // last segment of cwd is the only honest local proxy for `repo:`.
    split.repoTerms.map((term) => containsCondition(filter, CWD_BASENAME, term))
  )
  return filter
}

function addGroup(filter: SessionRowFilter, conditions: (string | null)[]): void {
  const present = conditions.filter((condition) => condition !== null)
  if (present.length > 0) {
    filter.conditions.push(`(${present.join(' OR ')})`)
  }
}

function pathTermCondition(filter: SessionRowFilter, term: string): string | null {
  if (isRuntimePathAbsolute(term)) {
    return insideCondition(filter, sessionSearchPathKey(term))
  }
  // A bare fragment cannot prove Windows semantics, so fold separators anyway:
  // `path:Work\App` is a Windows user typing, never a POSIX file named `Work\App`.
  const fragment = normalizeRuntimePathSeparators(term).replace(/\/+$/, '')
  return fragment ? containsCondition(filter, CWD, fragment) : null
}

/**
 * `key` itself, or anything below it. Why a half-open range and not
 * `substr(key, 1, length(?)) = ?`: only `>=`/`<` can seek `sessions_cwd_key`;
 * the substr form scans it. The bound is the child prefix with its last byte
 * incremented, so it stops at the end of that prefix and nowhere else. The two
 * arms cannot merge: one range over the bare key would also swallow a sibling
 * like `/work/app-other`. No wildcards, so `%`/`_` in a folder name are literal.
 */
function insideCondition(filter: SessionRowFilter, key: string): string {
  const children = `${key}/`
  filter.values.push(key, children, nextAfterPrefix(children))
  return `(${CWD} = ? OR (${CWD} >= ? AND ${CWD} < ?))`
}

/** The first string that sorts after every string starting with `prefix`. */
function nextAfterPrefix(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}

function containsCondition(filter: SessionRowFilter, column: string, term: string): string {
  // LIKE wildcards inside a user-typed term are literal text, not a pattern.
  filter.values.push(`%${term.normalize('NFC').replaceAll(/[\\%_]/g, '\\$&')}%`)
  return `${column} LIKE ? ESCAPE '\\'`
}
