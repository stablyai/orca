import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export type CollaborationBoardKind = 'announcement' | 'task' | 'handoff'
export type CollaborationBoardStatus = 'open' | 'claimed' | 'completed'

export type CollaborationBoardRow = {
  id: string
  scope_key: string
  kind: CollaborationBoardKind
  title: string
  body: string
  author_handle: string
  assignee_handle: string | null
  status: CollaborationBoardStatus
  created_at_ms: number
  updated_at_ms: number
}

export const RESOURCE_LOCK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS resource_locks (
  id TEXT PRIMARY KEY,
  resource_key TEXT NOT NULL,
  owner_handle TEXT NOT NULL,
  owner_pane_key TEXT,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held', 'queued', 'released', 'expired')),
  ttl_ms INTEGER NOT NULL DEFAULT 300000,
  acquired_at_ms INTEGER,
  expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  released_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resource_locks_key_status ON resource_locks(resource_key, status, created_at_ms);
CREATE TABLE IF NOT EXISTS collaboration_board_entries (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL DEFAULT 'global',
  kind TEXT NOT NULL DEFAULT 'announcement' CHECK(kind IN ('announcement', 'task', 'handoff')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_handle TEXT NOT NULL,
  assignee_handle TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'completed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collaboration_board_scope_status ON collaboration_board_entries(scope_key, status, created_at_ms DESC);
`

export function withImmediateTransaction<T>(
  db: OrchestrationDb['db'],
  savepointName: string,
  fn: () => T
): T {
  const nested = db.inTransaction
  db.exec(nested ? `SAVEPOINT ${savepointName}` : 'BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec(nested ? `RELEASE ${savepointName}` : 'COMMIT')
    return result
  } catch (error) {
    db.exec(nested ? `ROLLBACK TO ${savepointName}` : 'ROLLBACK')
    if (nested) {
      db.exec(`RELEASE ${savepointName}`)
    }
    throw error
  }
}

export function postBoardEntry(
  this: OrchestrationDb,
  input: {
    scopeKey?: string
    kind?: CollaborationBoardKind
    title: string
    body?: string
    authorHandle: string
    assigneeHandle?: string | null
    nowMs?: number
  }
): CollaborationBoardRow {
  const title = input.title.trim()
  if (!title) {
    throw new OrchestrationError('invalid_argument', 'Missing title for board entry.')
  }
  const nowMs = input.nowMs ?? Date.now()
  const id = generateId('board')
  const scopeKey = (input.scopeKey ?? 'global').trim() || 'global'
  const kind: CollaborationBoardKind = input.kind ?? 'announcement'
  const assigneeHandle = input.assigneeHandle?.trim() || null
  const status: CollaborationBoardStatus = assigneeHandle ? 'claimed' : 'open'

  this.db
    .prepare(
      `INSERT INTO collaboration_board_entries (
         id, scope_key, kind, title, body, author_handle,
         assignee_handle, status, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      scopeKey,
      kind,
      title,
      (input.body ?? '').trim(),
      input.authorHandle.trim(),
      assigneeHandle,
      status,
      nowMs,
      nowMs
    )

  return this.db
    .prepare('SELECT * FROM collaboration_board_entries WHERE id = ?')
    .get(id) as CollaborationBoardRow
}

export function claimBoardEntry(
  this: OrchestrationDb,
  input: {
    id: string
    assigneeHandle: string
    status?: 'claimed' | 'completed'
    nowMs?: number
  }
): CollaborationBoardRow {
  const nowMs = input.nowMs ?? Date.now()
  const nextStatus = input.status ?? 'claimed'
  const assigneeHandle = input.assigneeHandle.trim()

  return withImmediateTransaction(this.db, 'claim_board_entry', () => {
    const existing = this.db
      .prepare('SELECT * FROM collaboration_board_entries WHERE id = ?')
      .get(input.id) as CollaborationBoardRow | undefined
    if (!existing) {
      throw new OrchestrationError('lifecycle_not_found', `Board entry not found: ${input.id}`, {
        id: input.id
      })
    }
    if (
      existing.status !== 'open' &&
      existing.assignee_handle &&
      existing.assignee_handle !== assigneeHandle
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        `Board entry ${input.id} is already claimed by ${existing.assignee_handle}.`,
        { id: input.id, assigneeHandle: existing.assignee_handle }
      )
    }
    this.db
      .prepare(
        `UPDATE collaboration_board_entries
         SET assignee_handle = ?, status = ?, updated_at_ms = ?
         WHERE id = ?`
      )
      .run(assigneeHandle, nextStatus, nowMs, input.id)
    return this.db
      .prepare('SELECT * FROM collaboration_board_entries WHERE id = ?')
      .get(input.id) as CollaborationBoardRow
  })
}

export function listBoardEntries(
  this: OrchestrationDb,
  filter?: {
    scopeKey?: string
    kind?: CollaborationBoardKind
    status?: CollaborationBoardStatus
    limit?: number
  }
): CollaborationBoardRow[] {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (filter?.scopeKey) {
    clauses.push('scope_key = ?')
    params.push(filter.scopeKey.trim())
  }
  if (filter?.kind) {
    clauses.push('kind = ?')
    params.push(filter.kind)
  }
  if (filter?.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(200, filter?.limit ?? 50))
  params.push(limit)
  return this.db
    .prepare(
      `SELECT * FROM collaboration_board_entries
       ${whereSql}
       ORDER BY created_at_ms DESC, rowid DESC
       LIMIT ?`
    )
    .all(...params) as CollaborationBoardRow[]
}
