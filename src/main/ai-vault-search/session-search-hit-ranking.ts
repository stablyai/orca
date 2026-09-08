import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultSearchArgs, AiVaultSearchHit } from '../../shared/ai-vault-search-types'
import {
  AI_VAULT_SEARCH_LIMIT_DEFAULT,
  AI_VAULT_SEARCH_LIMIT_MAX
} from '../../shared/ai-vault-search-types'
import { isCollapsibleContentHash } from './session-search-content-hash'

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

type ScoredSession = {
  session: SessionRow
  message: MessageRow
  score: number
  duplicateCount: number
}

function sessionFields(session: SessionRow): Omit<AiVaultSearchHit, 'score' | 'evidence'> {
  return {
    agent: session.agent,
    sessionId: session.session_id,
    filePath: session.file_path,
    codexHome: session.codex_home,
    title: session.title,
    cwd: session.cwd,
    branch: session.branch,
    updatedAt: session.updated_at,
    messageCount: session.message_count,
    resumeCommand: session.resume_command
  }
}

// Why: the desktop IPC forwards its payload unvalidated, so a non-positive
// limit must be clamped here or `LIMIT -1` / `slice(0, -1)` leak through.
export function resolveLimit(args: AiVaultSearchArgs): number {
  const requested = Number.isInteger(args.limit)
    ? (args.limit as number)
    : AI_VAULT_SEARCH_LIMIT_DEFAULT
  return Math.min(Math.max(1, requested), AI_VAULT_SEARCH_LIMIT_MAX)
}

/**
 * Everything between "these sessions matched" and "this is the page": the length
 * prior, fork folding, the caller's order, and the cut. Retrieval stays in SQL;
 * nothing here touches the database, and `snippet` runs only for the page.
 */
export function rankSessionHits(
  sessions: readonly SessionRow[],
  matches: ReadonlyMap<number, MessageRow>,
  args: AiVaultSearchArgs,
  snippet: (message: MessageRow) => string
): AiVaultSearchHit[] {
  const scored = collapseForks(
    sessions.map((session) => {
      const message = matches.get(session.id)!
      return {
        session,
        message,
        score: message.score - LENGTH_PRIOR * Math.log(1 + session.message_count),
        duplicateCount: 1
      }
    })
  )
  scored.sort((left, right) =>
    args.sort === 'newest'
      ? (right.session.updated_at ?? '').localeCompare(left.session.updated_at ?? '')
      : right.score - left.score
  )
  return scored.slice(0, resolveLimit(args)).map(({ session, message, score, duplicateCount }) => ({
    ...sessionFields(session),
    score,
    ...(duplicateCount > 1 ? { duplicateCount } : {}),
    evidence: {
      role: message.role as AiVaultSearchHit['evidence']['role'],
      timestamp: message.ts,
      snippet: snippet(message)
    }
  }))
}

/**
 * Folds forked copies of one conversation into a single hit: same opening
 * prefix, newest `updated_at` wins, the rest become `duplicateCount`. Done here
 * and not at write time so index rows stay per file (cursors and deletes).
 */
function collapseForks(scored: ScoredSession[]): ScoredSession[] {
  const groups = new Map<string, ScoredSession[]>()
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
  const collapsed: ScoredSession[] = []
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

function isNewer(entry: ScoredSession, best: ScoredSession): boolean {
  const order = (entry.session.updated_at ?? '').localeCompare(best.session.updated_at ?? '')
  return order === 0 ? entry.score > best.score : order > 0
}
