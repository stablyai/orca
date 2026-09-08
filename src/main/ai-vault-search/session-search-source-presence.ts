import {
  AI_VAULT_SEARCH_LIMIT_DEFAULT,
  AI_VAULT_SEARCH_LIMIT_MAX,
  type AiVaultSearchArgs,
  type AiVaultSearchHit,
  type AiVaultSearchResult
} from '../../shared/ai-vault-search-types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { isWslUncPath } from '../../shared/wsl-paths'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from '../ai-vault/session-scanner-opencode-sqlite-paths'
import { readOpenCodeDatabase } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists } from '../opencode-usage/schema-helpers'

const MAX_PRESENCE_QUERIES = 4

type Presence = 'present' | 'missing' | 'unverifiable'
type Invalidate = (paths: string[]) => void

function candidatePath(hit: AiVaultSearchHit): string {
  const sqlite = buildOpenCodeSqliteCandidatePath(hit.filePath, hit.sessionId)
  return hit.agent === 'opencode' && splitOpenCodeSqliteCandidate(sqlite) ? sqlite : hit.filePath
}

async function checkSearchSources(
  hits: AiVaultSearchHit[],
  known: Map<string, Presence>,
  unavailable: Set<string>,
  invalidate: Invalidate,
  signal?: AbortSignal
): Promise<void> {
  const byPath = new Map<string, AiVaultSearchHit[]>()
  for (const hit of hits) {
    if (!known.has(candidatePath(hit))) {
      const group = byPath.get(hit.filePath) ?? []
      group.push(hit)
      byPath.set(hit.filePath, group)
    }
  }
  await mapWithConcurrency([...byPath], 4, async ([path, group]) => {
    throwIfSignalAborted(signal)
    const outcomes = new Map<string, Presence>()
    try {
      await wslGatedStat(path, 'scan', signal)
      throwIfSignalAborted(signal)
      const sqlite = group.filter((hit) => candidatePath(hit) !== path)
      if (sqlite.length) {
        // Windows cannot reliably lock SQLite on a WSL share; never open it on this thread.
        if (isWslUncPath(path)) {
          for (const hit of sqlite) {
            outcomes.set(candidatePath(hit), 'unverifiable')
          }
        } else {
          readOpenCodeDatabase({
            dbPath: path,
            read: (db) => {
              const live = db.prepare(
                `SELECT id FROM session WHERE id = ?${columnExists(db, 'session', 'time_archived') ? ' AND time_archived IS NULL' : ''}`
              )
              for (const hit of sqlite) {
                outcomes.set(candidatePath(hit), live.get(hit.sessionId) ? 'present' : 'missing')
              }
            }
          })
        }
      }
      for (const hit of group) {
        if (candidatePath(hit) === path) {
          outcomes.set(path, 'present')
        }
      }
    } catch (error) {
      throwIfSignalAborted(signal)
      const missing =
        !isWslUncPath(path) &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      outcomes.clear()
      for (const hit of group) {
        outcomes.set(candidatePath(hit), missing ? 'missing' : 'unverifiable')
      }
    }
    throwIfSignalAborted(signal)
    for (const [key, presence] of outcomes) {
      known.set(key, presence)
      if (presence === 'missing') {
        invalidate([key])
      }
      if (presence === 'unverifiable') {
        unavailable.add(path)
      }
    }
  })
  throwIfSignalAborted(signal)
}

/** Refill limited results after dropping deleted sources, without unbounded scans. */
export async function searchPresentSessionSources(
  args: AiVaultSearchArgs,
  search: (args: AiVaultSearchArgs) => AiVaultSearchResult,
  invalidate: Invalidate,
  signal?: AbortSignal
): Promise<AiVaultSearchResult> {
  const wanted = Math.min(
    AI_VAULT_SEARCH_LIMIT_MAX,
    Math.max(1, Number.isInteger(args.limit) ? args.limit! : AI_VAULT_SEARCH_LIMIT_DEFAULT)
  )
  const known = new Map<string, Presence>()
  const unavailable = new Set<string>()
  let limit = wanted
  let durationMs = 0
  for (let attempt = 1; ; attempt++) {
    throwIfSignalAborted(signal)
    const result = search({ ...args, limit })
    durationMs += result.durationMs
    await checkSearchSources(result.hits, known, unavailable, invalidate, signal)
    // Why: loss of contact is not evidence of absence (see
    // docs/reference/ssh-execution-boundary.md). Only a proven deletion drops a
    // hit; an unreadable source is still shown, counted in sourceUnavailableFiles.
    const hits = result.hits.filter((hit) => known.get(candidatePath(hit)) !== 'missing')
    const missing = result.hits.some((hit) => known.get(candidatePath(hit)) === 'missing')
    const exhausted = result.hits.length < limit && !missing
    const budgetExhausted =
      attempt === MAX_PRESENCE_QUERIES || (limit === AI_VAULT_SEARCH_LIMIT_MAX && !missing)
    if (hits.length >= wanted || exhausted || budgetExhausted) {
      const omitted =
        budgetExhausted && !exhausted && hits.length < wanted
          ? Math.max(1, result.hits.length - hits.length)
          : 0
      return {
        ...result,
        hits: hits.slice(0, wanted),
        durationMs,
        ...(unavailable.size ? { sourceUnavailableFiles: unavailable.size } : {}),
        ...(omitted ? { omittedHits: (result.omittedHits ?? 0) + omitted } : {})
      }
    }
    limit = Math.min(AI_VAULT_SEARCH_LIMIT_MAX, limit * 2)
  }
}
