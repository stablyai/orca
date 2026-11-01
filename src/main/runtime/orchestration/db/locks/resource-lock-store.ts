import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import {
  claimBoardEntry,
  listBoardEntries,
  postBoardEntry,
  RESOURCE_LOCK_SCHEMA_SQL,
  withImmediateTransaction,
  type CollaborationBoardKind,
  type CollaborationBoardRow,
  type CollaborationBoardStatus
} from './collaboration-board-store'

export {
  claimBoardEntry,
  listBoardEntries,
  postBoardEntry,
  RESOURCE_LOCK_SCHEMA_SQL,
  type CollaborationBoardKind,
  type CollaborationBoardRow,
  type CollaborationBoardStatus
}

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

export type ResourceLockEntry = ResourceLockRow & { position: number }

const DEFAULT_LOCK_TTL_MS = 300_000
const MIN_LOCK_TTL_MS = 1_000
const MAX_LOCK_TTL_MS = 3_600_000

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
      `SELECT * FROM resource_locks WHERE resource_key = ? AND status = 'held' ORDER BY created_at_ms ASC, rowid ASC`
    )
    .all(resourceKey) as ResourceLockRow[]

  let activeHolder: ResourceLockRow | null = null
  for (const row of heldRows) {
    if (row.expires_at_ms !== null && row.expires_at_ms <= nowMs) {
      db.db
        .prepare(
          `UPDATE resource_locks SET status = 'expired', released_at_ms = ? WHERE id = ? AND status = 'held'`
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
      `SELECT * FROM resource_locks WHERE resource_key = ? AND status = 'queued' ORDER BY created_at_ms ASC, rowid ASC LIMIT 1`
    )
    .get(resourceKey) as ResourceLockRow | undefined
  if (!nextQueued) {
    return null
  }

  const expiresAtMs = nowMs + nextQueued.ttl_ms
  db.db
    .prepare(
      `UPDATE resource_locks SET status = 'held', acquired_at_ms = ?, expires_at_ms = ? WHERE id = ?`
    )
    .run(nowMs, expiresAtMs, nextQueued.id)

  return (
    (db.db.prepare('SELECT * FROM resource_locks WHERE id = ?').get(nextQueued.id) as
      | ResourceLockRow
      | undefined) ?? null
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
): { lock: ResourceLockRow; position: number; holder: ResourceLockRow } {
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

  return withImmediateTransaction(this.db, 'acquire_resource_lock', () => {
    const activeHolder = sweepAndPromoteResourceKey(this, resourceKey, nowMs)

    if (activeHolder && activeHolder.owner_handle === ownerHandle) {
      const expiresAtMs = nowMs + ttlMs
      const nextReason = reason || activeHolder.reason
      this.db
        .prepare(`UPDATE resource_locks SET ttl_ms = ?, expires_at_ms = ?, reason = ? WHERE id = ?`)
        .run(ttlMs, expiresAtMs, nextReason, activeHolder.id)
      const updated = this.db
        .prepare('SELECT * FROM resource_locks WHERE id = ?')
        .get(activeHolder.id) as ResourceLockRow
      return { lock: updated, position: 0, holder: updated }
    }

    const existingQueued = this.db
      .prepare(
        `SELECT * FROM resource_locks WHERE resource_key = ? AND owner_handle = ? AND status = 'queued' ORDER BY created_at_ms ASC, rowid ASC LIMIT 1`
      )
      .get(resourceKey, ownerHandle) as ResourceLockRow | undefined

    if (existingQueued && activeHolder) {
      const queuedRows = this.db
        .prepare(
          `SELECT id FROM resource_locks WHERE resource_key = ? AND status = 'queued' ORDER BY created_at_ms ASC, rowid ASC`
        )
        .all(resourceKey) as { id: string }[]
      const index = queuedRows.findIndex((row) => row.id === existingQueued.id)
      return {
        lock: existingQueued,
        position: index !== -1 ? index + 1 : 1,
        holder: activeHolder
      }
    }

    const id = generateId('lock')
    if (!activeHolder) {
      const expiresAtMs = nowMs + ttlMs
      this.db
        .prepare(
          `INSERT INTO resource_locks (id, resource_key, owner_handle, owner_pane_key, reason, status, ttl_ms, acquired_at_ms, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`
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
      return { lock: created, position: 0, holder: created }
    }

    this.db
      .prepare(
        `INSERT INTO resource_locks (id, resource_key, owner_handle, owner_pane_key, reason, status, ttl_ms, acquired_at_ms, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?)`
      )
      .run(id, resourceKey, ownerHandle, input.ownerPaneKey ?? null, reason, ttlMs, nowMs)

    const created = this.db
      .prepare('SELECT * FROM resource_locks WHERE id = ?')
      .get(id) as ResourceLockRow
    const queuedRows = this.db
      .prepare(
        `SELECT id FROM resource_locks WHERE resource_key = ? AND status = 'queued' ORDER BY created_at_ms ASC, rowid ASC`
      )
      .all(resourceKey) as { id: string }[]
    const index = queuedRows.findIndex((row) => row.id === id)
    return {
      lock: created,
      position: index !== -1 ? index + 1 : queuedRows.length,
      holder: activeHolder
    }
  })
}

export function releaseResourceLock(
  this: OrchestrationDb,
  input: { resourceKey: string; ownerHandle: string; force?: boolean; nowMs?: number }
): {
  released: boolean
  releasedLock: ResourceLockRow | null
  promoted: ResourceLockRow | null
} {
  const resourceKey = input.resourceKey.trim()
  const ownerHandle = input.ownerHandle.trim()
  const nowMs = input.nowMs ?? Date.now()

  return withImmediateTransaction(this.db, 'release_resource_lock', () => {
    sweepAndPromoteResourceKey(this, resourceKey, nowMs)
    const target = input.force
      ? (this.db
          .prepare(
            `SELECT * FROM resource_locks WHERE resource_key = ? AND status IN ('held', 'queued') ORDER BY CASE status WHEN 'held' THEN 0 ELSE 1 END, created_at_ms ASC, rowid ASC LIMIT 1`
          )
          .get(resourceKey) as ResourceLockRow | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM resource_locks WHERE resource_key = ? AND owner_handle = ? AND status IN ('held', 'queued') ORDER BY CASE status WHEN 'held' THEN 0 ELSE 1 END, created_at_ms ASC, rowid ASC LIMIT 1`
          )
          .get(resourceKey, ownerHandle) as ResourceLockRow | undefined)

    if (!target) {
      sweepAndPromoteResourceKey(this, resourceKey, nowMs)
      return { released: false, releasedLock: null, promoted: null }
    }

    this.db
      .prepare(`UPDATE resource_locks SET status = 'released', released_at_ms = ? WHERE id = ?`)
      .run(nowMs, target.id)
    const releasedLock = this.db
      .prepare('SELECT * FROM resource_locks WHERE id = ?')
      .get(target.id) as ResourceLockRow
    const promoted = sweepAndPromoteResourceKey(this, resourceKey, nowMs)
    return {
      released: true,
      releasedLock,
      promoted: target.status === 'held' ? promoted : null
    }
  })
}

export function listResourceLocks(
  this: OrchestrationDb,
  filter?: { resourceKey?: string; nowMs?: number }
): ResourceLockEntry[] {
  const nowMs = filter?.nowMs ?? Date.now()
  const keys = filter?.resourceKey
    ? [filter.resourceKey.trim()]
    : (
        this.db
          .prepare(
            `SELECT DISTINCT resource_key FROM resource_locks WHERE status IN ('held', 'queued') ORDER BY resource_key ASC`
          )
          .all() as { resource_key: string }[]
      ).map((row) => row.resource_key)

  const entries: ResourceLockEntry[] = []
  for (const key of keys) {
    sweepAndPromoteResourceKey(this, key, nowMs)
    const rows = this.db
      .prepare(
        `SELECT * FROM resource_locks WHERE resource_key = ? AND status IN ('held', 'queued') ORDER BY CASE status WHEN 'held' THEN 0 ELSE 1 END, created_at_ms ASC, rowid ASC`
      )
      .all(key) as ResourceLockRow[]
    rows.forEach((row, index) => {
      entries.push({ ...row, position: row.status === 'held' ? 0 : index })
    })
  }
  return entries
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
