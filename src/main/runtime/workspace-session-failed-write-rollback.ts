import { isDeepStrictEqual } from 'node:util'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const MISSING = Symbol('missing')
type RollbackValue = unknown

function isRecord(value: RollbackValue): value is Record<string, unknown> {
  return (
    value !== MISSING &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function rollbackValue(
  original: RollbackValue,
  staged: RollbackValue,
  current: RollbackValue
): RollbackValue {
  if (isDeepStrictEqual(original, staged)) {
    return current
  }
  if (isDeepStrictEqual(current, staged)) {
    return original
  }
  if (!isRecord(original) || !isRecord(staged) || !isRecord(current)) {
    return current
  }
  let changed = false
  const next: Record<string, unknown> = { ...current }
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
  return rollbackValue(original, staged, current) as WorkspaceSessionState
}
