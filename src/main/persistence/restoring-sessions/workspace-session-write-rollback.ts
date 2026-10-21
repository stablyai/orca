import { isDeepStrictEqual } from 'node:util'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

const MISSING = Symbol('missing')

/** A JSON-shaped slot of persisted session state, or the absent-key sentinel. */
type RollbackSlot =
  | string
  | number
  | boolean
  | null
  | undefined
  | typeof MISSING
  | readonly RollbackSlot[]
  | RollbackRecord

type RollbackRecord = { readonly [key: string]: RollbackSlot }

function isRecord(value: RollbackSlot): value is RollbackRecord {
  return (
    value !== MISSING &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

type IdentifiedRecord = RollbackRecord & { readonly id: string }

function identifiedRows(value: RollbackSlot): readonly IdentifiedRecord[] | null {
  if (value === MISSING) {
    return []
  }
  if (
    !Array.isArray(value) ||
    !value.every((row): row is IdentifiedRecord => isRecord(row) && typeof row.id === 'string')
  ) {
    return null
  }
  return new Set(value.map((row) => row.id)).size === value.length ? value : null
}

function rollbackIdentifiedRows(
  original: RollbackSlot,
  staged: RollbackSlot,
  current: RollbackSlot
): readonly RollbackSlot[] | null {
  if (!Array.isArray(original) && !Array.isArray(staged) && !Array.isArray(current)) {
    return null
  }
  const before = identifiedRows(original)
  const written = identifiedRows(staged)
  const latest = identifiedRows(current)
  if (!before || !written || !latest) {
    return null
  }
  const beforeById = new Map(before.map((row) => [row.id, row]))
  const writtenById = new Map(written.map((row) => [row.id, row]))
  const latestById = new Map(latest.map((row) => [row.id, row]))
  const restored = new Map<string, RollbackSlot>()
  for (const id of new Set([...beforeById.keys(), ...writtenById.keys(), ...latestById.keys()])) {
    const value = rollbackValue(
      beforeById.get(id) ?? MISSING,
      writtenById.get(id) ?? MISSING,
      latestById.get(id) ?? MISSING
    )
    if (value !== MISSING) {
      restored.set(id, value)
    }
  }
  const order = latest.map((row) => row.id).filter((id) => restored.has(id))
  for (const [index, row] of before.entries()) {
    if (restored.has(row.id) && !order.includes(row.id)) {
      order.splice(Math.min(index, order.length), 0, row.id)
    }
  }
  return order.map((id) => restored.get(id))
}

function rollbackValue(
  original: RollbackSlot,
  staged: RollbackSlot,
  current: RollbackSlot
): RollbackSlot {
  if (isDeepStrictEqual(original, staged)) {
    return current
  }
  if (isDeepStrictEqual(current, staged)) {
    return original
  }
  // Terminal and unified tab rows have stable ids; unrelated row edits must survive rollback.
  const rows = rollbackIdentifiedRows(original, staged, current)
  if (rows) {
    return rows
  }
  if (!isRecord(original) || !isRecord(staged) || !isRecord(current)) {
    return current
  }
  let changed = false
  const next: Record<string, RollbackSlot> = { ...current }
  for (const key of new Set([
    ...Object.keys(original),
    ...Object.keys(staged),
    ...Object.keys(current)
  ])) {
    const value = rollbackValue(
      Object.hasOwn(original, key) ? original[key] : MISSING,
      Object.hasOwn(staged, key) ? staged[key] : MISSING,
      Object.hasOwn(current, key) ? current[key] : MISSING
    )
    if (value === MISSING) {
      if (Object.hasOwn(next, key)) {
        delete next[key]
        changed = true
      }
    } else if (!Object.hasOwn(current, key) || !isDeepStrictEqual(current[key], value)) {
      next[key] = value
      changed = true
    }
  }
  return changed ? next : current
}

export function rollbackWorkspaceSessionAfterFailedAsyncWrite(
  original: WorkspaceSessionState,
  staged: WorkspaceSessionState,
  current: WorkspaceSessionState
): WorkspaceSessionState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each restored field retains a value from the same field of a typed session.
  return rollbackValue(original, staged, current) as WorkspaceSessionState
}
