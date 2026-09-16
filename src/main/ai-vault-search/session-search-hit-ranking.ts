import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { isCollapsibleContentHash } from './session-search-content-hash'
import type { SessionSearchSort } from './session-search-engine-types'

// Subtracted per session: `0.02 · ln(1 + messages)`; slightly positive on both eval sets.
const LENGTH_PRIOR = 0.02

export type SessionRow = {
  id: number
  agent: AiVaultAgent
  session_id: string
  file_path: string
  codex_home: string | null
  title: string
  cwd: string | null
  branch: string | null
  updated_at: string | null
  message_count: number
  resume_command: string
  content_hash: string | null
  content_hash_count: number
}

/** The one message that stands for a session: its best-scoring match. */
export type MessageRow = {
  rowid: number
  score: number
  session_row_id: number
  role: string
  ts: string | null
}

export type RankedSession = {
  session: SessionRow
  /** Null on an operator-only page: the session matched no text at all. */
  message: MessageRow | null
  score: number
  duplicateCount: number
}

/**
 * Everything between "these sessions matched" and "this is the ranked list":
 * the length prior, fork folding and the caller's order. Retrieval stays in SQL
 * and nothing here touches the database.
 *
 * The whole list is returned, not a page: a cursor indexes into it, and slicing
 * here would make page two a different ranking from page one. The engine cuts
 * the page and only then pays for a snippet.
 */
export function rankSessionHits(
  sessions: readonly SessionRow[],
  matches: ReadonlyMap<number, MessageRow>,
  sort: SessionSearchSort
): RankedSession[] {
  const scored = collapseForks(
    sessions.map((session) => {
      const message = matches.get(session.id) ?? null
      return {
        session,
        message,
        score: (message?.score ?? 0) - LENGTH_PRIOR * Math.log(1 + session.message_count),
        duplicateCount: 1
      }
    })
  )
  // Why a total order and not just the key: a cursor is an offset into this
  // list, so two entries that tie must not be free to swap between pages.
  scored.sort(
    (left, right) =>
      (sort === 'newest'
        ? (right.session.updated_at ?? '').localeCompare(left.session.updated_at ?? '')
        : right.score - left.score) || left.session.id - right.session.id
  )
  return scored
}

/**
 * Folds forked copies of one conversation into a single entry: same opening
 * prefix, newest `updated_at` wins, the rest become `duplicateCount`. Done here
 * and not at write time so index rows stay per file (cursors and deletes).
 */
function collapseForks(scored: RankedSession[]): RankedSession[] {
  const groups = new Map<string, RankedSession[]>()
  for (const entry of scored) {
    const { content_hash: hash, content_hash_count: count, id } = entry.session
    const key = isCollapsibleContentHash(hash, count) ? `hash:${hash}` : `session:${id}`
    const group = groups.get(key)
    if (group) {
      group.push(entry)
    } else {
      groups.set(key, [entry])
    }
  }
  const collapsed: RankedSession[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      collapsed.push(group[0]!)
      continue
    }
    const winner = group.reduce((best, entry) => (isNewer(entry, best) ? entry : best))
    collapsed.push({ ...winner, duplicateCount: group.length })
  }
  return collapsed
}

function isNewer(entry: RankedSession, best: RankedSession): boolean {
  const order = (entry.session.updated_at ?? '').localeCompare(best.session.updated_at ?? '')
  return order === 0 ? entry.score > best.score : order > 0
}
