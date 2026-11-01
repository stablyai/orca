import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export type ResourceLockStatus = 'held' | 'queued' | 'released' | 'expired'

export type ResourceLockRow = {
  id: string
  resource_key: string
  owner_handle: string
  owner_pane_key: string | null
  reason: string
  status: ResourceLockStatus
  ttl_ms: number
  acquired_at_ms: number | null
  expires_at_ms: number | null
  created_at_ms: number
  released_at_ms: number | null
}

export type ResourceLockEntry = ResourceLockRow & {
  position: number
}

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

const DEFAULT_LOCK_TTL_MS = 300_000
const MIN_LOCK_TTL_MS = 1_000
const MAX_LOCK_TTL_MS = 3_600_000

export const RESOURCE_LOCK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS resource_locks (
  id              TEXT PRIMARY KEY,
  resource_key    TEXT NOT NULL,
  owner_handle    TEXT NOT NULL,
  owner_pane_key  TEXT,
  reason          TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'held'
    CHECK(status IN ('held', 'queued', 'released', 'expired')),
  ttl_ms          INTEGER NOT NULL DEFAULT 300000,
  acquired_at_ms  INTEGER,
  expires_at_ms   INTEGER,
  created_at_ms   INTEGER NOT NULL,
  released_at_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_resource_locks_key_status
  ON resource_locks(resource_key, status, created_at_ms);

CREATE TABLE IF NOT EXISTS collaboration_board_entries (
  id              TEXT PRIMARY KEY,
  scope_key       TEXT NOT NULL DEFAULT 'global',
  kind            TEXT NOT NULL DEFAULT 'announcement'
    CHECK(kind IN ('announcement', 'task', 'handoff')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  author_handle   TEXT NOT NULL,
  assignee_handle TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'claimed', 'completed')),
  created_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collaboration_board_scope_status
  ON collaboration_board_entries(scope_key, status, created_at_ms DESC);
`

function clampTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) {
    return DEFAULT_LOCK_TTL_MS
  }
  return Math.max(MIN_LOCK_TTL_MS, Math.min(MAX_LOCK_TTL_MS, Math.trunc(ttlMs)))
}

function sweepAndPromoteResourceKey(
  db: OrchestrationDb,
  resourceKey: string,
  nowMs: number
): ResourceLockRow | null {
  const heldRows = db.db
    .prepare(
      `SELECT * FROM resource_locks
       WHERE resource_key = ? AND status = 'held'
       ORDER BY created_at_ms ASC, rowid ASC`
    )
    .all(resourceKey) as ResourceLockRow[]

  let activeHolder: ResourceLockRow | null = null
  for (const row of heldRows) {
    if (row.expires_at_ms !== null && row.expires_at_ms <= nowMs) {
      db.db
        .prepare(
          `UPDATE resource_locks
           SET status = 'expired', released_at_ms = ?
           WHERE id = ? AND status = 'held'`
        )
        .run(nowMs, row.id)
    } else if (!activeHolder) {
      activeHolder = row
    }
  }

  if (activeHolder) {
    return activeHolder
  }

  const nextQueued = db.db
    .prepare(
      `SELECT * FROM resource_locks
       WHERE resource_key = ? AND status = 'queued'
       ORDER BY created_at_ms ASC, rowid ASC
       LIMIT 1`
    )
    .get(resourceKey) as ResourceLockRow | undefined

  if (!nextQueued) {
    return null
  }

  const expiresAtMs = nowMs + nextQueued.ttl_ms
  db.db
    .prepare(
      `UPDATE resource_locks
       SET status = 'held', acquired_at_ms = ?, expires_at_ms = ?
       WHERE id = ?`
    )
    .run(nowMs, expiresAtMs, nextQueued.id)

  return (
    (db.db
      .prepare('SELECT * FROM resource_locks WHERE id = ?')
      .get(nextQueued.id) as ResourceLockRow | undefined) ?? null
  )
}

export function acquireResourceLock(
  this: OrchestrationDb,
  input: {
    resourceKey: string
    ownerHandle: string
    ownerPaneKey?: string | null
    reason?: string
    ttlMs?: number
    nowMs?: number
  }
): {
  lock: ResourceLockRow
  position: number
  holder: ResourceLockRow
} {
  const resourceKey = input.resourceKey.trim()
  const ownerHandle = input.ownerHandle.trim()
  if (!resourceKey) {
    throw new OrchestrationError('invalid_argument', 'Missing resourceKey for lock acquisition.')
  }
  if (!ownerHandle) {
    throw new OrchestrationError('invalid_argument', 'Missing ownerHandle for lock acquisition.')
  }
  const nowMs = input.nowMs ?? Date.now()
  const ttlMs = clampTtlMs(input.ttlMs)
  const reason = (input.reason ?? '').trim()

  this.db.exec('SAVEPOINT acquire_resource_lock')
  try {
    const activeHolder = sweepAndPromoteResourceKey(this, resourceKey, nowMs)

    if (activeHolder && activeHolder.owner_handle === ownerHandle) {
      const expiresAtMs = nowMs + ttlMs
      const nextReason = reason || activeHolder.reason
      this.db
        .prepare(
          `UPDATE resource_locks
           SET ttl_ms = ?, expires_at_ms = ?, reason = ?
           WHERE id = ?`
        )
        .run(ttlMs, expiresAtMs, nextReason, activeHolder.id)
      const updated = this.db
        .prepare('SELECT * FROM resource_locks WHERE id = ?')
        .get(activeHolder.id) as ResourceLockRow
      this.db.exec('RELEASE acquire_resource_lock')
      return { lock: updated, position: 0, holder: updated }
    }

    const existingQueued = this.db
      .prepare(
        `SELECT * FROM resource_locks
         WHERE resource_key = ? AND owner_handle = ? AND status = 'queued'
         ORDER BY created_at_ms ASC, rowid ASC
         LIMIT 1`
      )
      .get(resourceKey, ownerHandle) as ResourceLockRow | undefined

    if (existingQueued && activeHolder) {
      const queuedRows = this.db
        .prepare(
          `SELECT id FROM resource_locks
           WHERE resource_key = ? AND status = 'queued'
           ORDER BY created_at_ms ASC, rowid ASC`
        )
        .all(resourceKey) as { id: string }[]
      const index = queuedRows.findIndex((row) => row.id === existingQueued.id)
      this.db.exec('RELEASE acquire_resource_lock')
      return {
        lock: existingQueued,
        position: index >= 0 ? index + 1 : 1,
        holder: activeHolder
      }
    }

    const id = generateId('lock')
    if (!activeHolder) {
      const expiresAtMs = nowMs + ttlMs
      this.db
        .prepare(
          `INSERT INTO resource_locks (
             id, resource_key, owner_handle, owner_pane_key, reason,
             status, ttl_ms, acquired_at_ms, expires_at_ms, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`
        )
        .run(
          id,
          resourceKey,
          ownerHandle,
          input.ownerPaneKey ?? null,
          reason,
          ttlMs,
          nowMs,
          expiresAtMs,
          nowMs
        )
      const created = this.db
        .prepare('SELECT * FROM resource_locks WHERE id = ?')
        .get(id) as ResourceLockRow
      this.db.exec('RELEASE acquire_resource_lock')
      return { lock: created, position: 0, holder: created }
    }

    this.db
      .prepare(
        `INSERT INTO resource_locks (
           id, resource_key, owner_handle, owner_pane_key, reason,
           status, ttl_ms, acquired_at_ms, expires_at_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?)`
      )
      .run(id, resourceKey, ownerHandle, input.ownerPaneKey ?? null, reason, ttlMs, nowMs)

    const created = this.db
      .prepare('SELECT * FROM resource_locks WHERE id = ?')
      .get(id) as ResourceLockRow
    const queuedRows = this.db
      .prepare(
        `SELECT id FROM resource_locks
         WHERE resource_key = ? AND status = 'queued'
         ORDER BY created_at_ms ASC, rowid ASC`
      )
      .all(resourceKey) as { id: string }[]
    const index = queuedRows.findIndex((row) => row.id === id)
    this.db.exec('RELEASE acquire_resource_lock')
    return {
      lock: created,
      position: index >= 0 ? index + 1 : queuedRows.length,
      holder: activeHolder
    }
  } catch (error) {
    this.db.exec('ROLLBACK TO acquire_resource_lock')
    this.db.exec('RELEASE acquire_resource_lock')
    throw error
  }
}

export function releaseResourceLock(
  this: OrchestrationDb,
  input: {
    resourceKey: string
    ownerHandle: string
    force?: boolean
    nowMs?: number
  }
): {
  released: boolean
  releasedLock: ResourceLockRow | null
  promoted: ResourceLockRow | null
} {
  const resourceKey = input.resourceKey.trim()
  const ownerHandle = input.ownerHandle.trim()
  const nowMs = input.nowMs ?? Date.now()

  this.db.exec('SAVEPOINT release_resource_lock')
  try {
    sweepAndPromoteResourceKey(this, resourceKey, nowMs)

    const target = input.force
      ? (this.db
          .prepare(
            `SELECT * FROM resource_locks
             WHERE resource_key = ? AND status IN ('held', 'queued')
             ORDER BY CASE status WHEN 'held' THEN 0 ELSE 1 END, created_at_ms ASC, rowid ASC
             LIMIT 1`
          )
          .get(resourceKey) as ResourceLockRow | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM resource_locks
             WHERE resource_key = ? AND owner_handle = ? AND status IN ('held', 'queued')
             ORDER BY CASE status WHEN 'held' THEN 0 ELSE 1 END, created_at_ms ASC, rowid ASC
             LIMIT 1`
          )
          .get(resourceKey, ownerHandle) as ResourceLockRow | undefined)

    if (!target) {
      const currentHolder = sweepAndPromoteResourceKey(this, resourceKey, nowMs)
      this.db.exec('RELEASE release_resource_lock')
      return { released: false, releasedLock: null, promoted: currentHolder }
    }

    this.db
      .prepare(
        `UPDATE resource_locks
         SET status = 'released', released_at_ms = ?
         WHERE id = ?`
      )
      .run(nowMs, target.id)

    const releasedLock = this.db
      .prepare('SELECT * FROM resource_locks WHERE id = ?')
      .get(target.id) as ResourceLockRow
    const promoted = sweepAndPromoteResourceKey(this, resourceKey, nowMs)
    this.db.exec('RELEASE release_resource_lock')
    return { released: true, releasedLock, promoted }
  } catch (error) {
    this.db.exec('ROLLBACK TO release_resource_lock')
    this.db.exec('RELEASE release_resource_lock')
    throw error
  }
}

export function listResourceLocks(
  this: OrchestrationDb,
  filter?: {
    resourceKey?: string
    nowMs?: number
  }
): ResourceLockEntry[] {
  const nowMs = filter?.nowMs ?? Date.now()
  const keys = filter?.resourceKey
    ? [filter.resourceKey.trim()]
    : (
        this.db
          .prepare(
            `SELECT DISTINCT resource_key FROM resource_locks
             WHERE status IN ('held', 'queued')
             ORDER BY resource_key ASC`
          )
          .all() as { resource_key: string }[]
      ).map((row) => row.resource_key)

  const entries: ResourceLockEntry[] = []
  for (const key of keys) {
    sweepAndPromoteResourceKey(this, key, nowMs)
    const rows = this.db
      .prepare(
        `SELECT * FROM resource_locks
         WHERE resource_key = ? AND status IN ('held', 'queued')
         ORDER BY CASE status WHEN 'held' THEN 0 ELSE 1 END, created_at_ms ASC, rowid ASC`
      )
      .all(key) as ResourceLockRow[]
    rows.forEach((row, index) => {
      entries.push({
        ...row,
        position: row.status === 'held' ? 0 : index
      })
    })
  }
  return entries
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

  this.db.exec('SAVEPOINT claim_board_entry')
  try {
    const existing = this.db
      .prepare('SELECT * FROM collaboration_board_entries WHERE id = ?')
      .get(input.id) as CollaborationBoardRow | undefined
    if (!existing) {
      throw new OrchestrationError('lifecycle_not_found', `Board entry not found: ${input.id}`, {
        id: input.id
      })
    }
    if (
      nextStatus === 'claimed' &&
      existing.status === 'claimed' &&
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
    const updated = this.db
      .prepare('SELECT * FROM collaboration_board_entries WHERE id = ?')
      .get(input.id) as CollaborationBoardRow
    this.db.exec('RELEASE claim_board_entry')
    return updated
  } catch (error) {
    this.db.exec('ROLLBACK TO claim_board_entry')
    this.db.exec('RELEASE claim_board_entry')
    throw error
  }
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

export type ResourceLockStoreMethods = {
  acquireResourceLock: typeof acquireResourceLock
  releaseResourceLock: typeof releaseResourceLock
  listResourceLocks: typeof listResourceLocks
  postBoardEntry: typeof postBoardEntry
  claimBoardEntry: typeof claimBoardEntry
  listBoardEntries: typeof listBoardEntries
}

export function attachResourceLockStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    acquireResourceLock,
    releaseResourceLock,
    listResourceLocks,
    postBoardEntry,
    claimBoardEntry,
    listBoardEntries
  })
}
