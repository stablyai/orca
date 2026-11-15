import type { KeyedJsonRow } from './keyed-json-row-cache'

export type StoredRow = { seq: number; json: string }
type RowWritePlan = {
  changes: Map<string, StoredRow | null>
  maxSeq: number
  next?: Map<string, StoredRow>
}

export function planFullRows(
  baseline: ReadonlyMap<string, StoredRow>,
  maxSeq: number,
  rows: readonly KeyedJsonRow[]
): RowWritePlan {
  const next = new Map<string, StoredRow>()
  let previous = 0
  for (const { key, json } of rows) {
    const old = baseline.get(key)
    const seq = old && old.seq > previous ? old.seq : ++maxSeq
    previous = seq
    next.set(key, { seq, json })
  }
  const changes = new Map<string, StoredRow | null>()
  for (const [key, row] of next) {
    const old = baseline.get(key)
    if (!old || old.seq !== row.seq || old.json !== row.json) {
      changes.set(key, row)
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
  const changes = new Map<string, StoredRow | null>()
  for (const [key, json] of values) {
    const old = baseline.get(key)
    if (json === null) {
      if (old) {
        changes.set(key, null)
      }
    } else {
      const seq = reinsertKeys?.has(key) ? ++maxSeq : (old?.seq ?? ++maxSeq)
      if (!old || old.json !== json || old.seq !== seq) {
        changes.set(key, { seq, json })
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
