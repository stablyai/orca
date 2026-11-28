import { createHash } from 'node:crypto'
import type { RowCacheWalCheckpoints } from './row-cache-wal-checkpoints'

export type KeyedJsonRow = { key: string; json: string }

export type KeyedJsonRowCacheOptions = {
  schemaVersion: number
  /** Lock wait per call. Main-thread callers keep it short and retry later instead. */
  busyTimeoutMs?: number
  /** False opens and closes the database per call, so no handle outlives it (profile moves). */
  holdConnection?: boolean
  /** JSON file older builds wrote; see load(). */
  legacyPath?: string
  walCheckpoints?: Pick<
    RowCacheWalCheckpoints,
    'available' | 'attach' | 'detach' | 'request' | 'assertRemovable'
  >
}

export type KeyedJsonRowLoad<T> =
  | { kind: 'rows'; rows: KeyedJsonRow[] }
  | { kind: 'import'; value: T; receipt: string; rows: KeyedJsonRow[] }
  | { kind: 'unavailable'; error: unknown; legacy?: T }

export type RowWriteOptions = {
  importReceipt?: string
  busyTimeoutMs?: number
  reinsertKeys?: ReadonlySet<string>
}

export type StoredRow = { seq: number; hash: string }
export type PlannedRowWrite = { seq: number; json: string; hash: string }
type RowWritePlan = {
  changes: Map<string, PlannedRowWrite | null>
  maxSeq: number
  next?: Map<string, StoredRow>
}

// Retain a fixed-size digest instead of full JSON payloads so multi-megabyte caches do not sit in RAM.
export function hashKeyedJsonRow(json: string): string {
  return createHash('sha256').update(json).digest('base64')
}

export function planFullRows(
  baseline: ReadonlyMap<string, StoredRow>,
  maxSeq: number,
  rows: readonly KeyedJsonRow[]
): RowWritePlan {
  const next = new Map<string, StoredRow>()
  const changes = new Map<string, PlannedRowWrite | null>()
  let previous = 0
  for (const { key, json } of rows) {
    const old = baseline.get(key)
    const seq = old && old.seq > previous ? old.seq : ++maxSeq
    previous = seq
    const hash = hashKeyedJsonRow(json)
    next.set(key, { seq, hash })
    if (!old || old.seq !== seq || old.hash !== hash) {
      changes.set(key, { seq, json, hash })
    } else {
      changes.delete(key)
    }
  }
  for (const key of baseline.keys()) {
    if (!next.has(key)) {
      changes.set(key, null)
    }
  }
  return { changes, maxSeq, next }
}

export function planRowPatch(
  baseline: ReadonlyMap<string, StoredRow>,
  maxSeq: number,
  values: ReadonlyMap<string, string | null>,
  reinsertKeys?: ReadonlySet<string>
): RowWritePlan {
  const changes = new Map<string, PlannedRowWrite | null>()
  for (const [key, json] of values) {
    const old = baseline.get(key)
    if (json === null) {
      if (old) {
        changes.set(key, null)
      }
    } else {
      const seq = reinsertKeys?.has(key) ? ++maxSeq : (old?.seq ?? ++maxSeq)
      const hash = hashKeyedJsonRow(json)
      if (!old || old.hash !== hash || old.seq !== seq) {
        changes.set(key, { seq, json, hash })
      }
    }
  }
  return { changes, maxSeq }
}

export function parseKeyedJsonRows(
  rows: readonly KeyedJsonRow[]
): { key: string; value: unknown }[] {
  return rows.flatMap(({ key, json }) => {
    try {
      const value: unknown = JSON.parse(json)
      return [{ key, value }]
    } catch {
      return []
    }
  })
}

export function parseOrNull<T>(parse: (text: string) => T | null, text: string): T | null {
  try {
    return parse(text)
  } catch {
    return null
  }
}

export function receiptNames(stored: unknown, receipt: string): boolean {
  if (typeof stored !== 'string') {
    return false
  }
  return stored === receipt || /^\d+:\d+:([0-9a-f]{64})$/.exec(stored)?.[1] === receipt
}
