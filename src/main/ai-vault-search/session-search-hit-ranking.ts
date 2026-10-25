import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { isCollapsibleContentHash } from './session-search-content-hash'
import type { SessionSearchSort } from './session-search-engine-types'

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

/** Rank and fold forks across the full candidate list before the engine slices cursor pages. */
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
  // Newer sessions win score ties; row ids make cursor ordering deterministic.
  scored.sort(
    (left, right) =>
      (sort === 'newest' ? 0 : right.score - left.score) ||
      (right.session.updated_at ?? '').localeCompare(left.session.updated_at ?? '') ||
      left.session.id - right.session.id
  )
  return scored
}

/** Fold matching prefixes at query time so per-file indexing cursors and deletion remain independent. */
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
