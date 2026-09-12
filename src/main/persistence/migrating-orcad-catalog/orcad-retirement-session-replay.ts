import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { parseOrcadLiveSourceRetirementRecord } from '../../ssh/orcad-live-source-retirement-record'

type RetirementRecord = ReturnType<typeof parseOrcadLiveSourceRetirementRecord>
type JsonMap = Record<string, unknown>
const equal = (left: unknown, right: unknown) =>
  serializeOrcadMigrationValue(left) === serializeOrcadMigrationValue(right)
const isMap = (value: unknown): value is JsonMap =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function replayConflict(field: string, before?: unknown, current?: unknown): Error {
  const fields =
    isMap(before) && isMap(current)
      ? [...new Set([...Object.keys(before), ...Object.keys(current)])].filter(
          (key) => !equal(before[key], current[key])
        )
      : undefined
  return new Error('orcad_retirement_session_replay_conflict', {
    cause: { field, ...(fields ? { recordFields: fields } : {}) }
  })
}

/** Caller holds installed-record authority; only exact recorded replay may be discarded. */
export function reconcileOrcadRetirementSessionReplay(
  session: WorkspaceSessionState,
  hostId: string,
  record: RetirementRecord
): WorkspaceSessionState {
  const sourceHost = toSshExecutionHostId(record.release.cutover.manifest.source.sshTargetId)
  if (hostId !== 'local' && hostId !== sourceHost) {
    return session
  }
  const change = record.changes.find(
    ({ field }) => field === (hostId === 'local' ? 'workspaceSession' : 'workspaceSessionsByHostId')
  )
  if (!change) {
    return session
  }
  const read = (value: string | null): JsonMap => {
    const parsed: unknown = value === null ? {} : JSON.parse(value)
    if (!isMap(parsed)) {
      throw new Error('orcad_retirement_session_record_invalid')
    }
    const slice = hostId === 'local' ? parsed : (parsed[hostId] ?? {})
    if (!isMap(slice)) {
      throw new Error('orcad_retirement_session_record_invalid')
    }
    return slice
  }
  const before = read(change.before)
  const after = read(change.after)
  const next: JsonMap = { ...session }
  let changed = false
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (equal(before[field], after[field])) {
      continue
    }
    const current = next[field]
    if (equal(current, after[field])) {
      continue
    }
    if (equal(current, before[field])) {
      if (Object.hasOwn(after, field)) {
        next[field] = structuredClone(after[field])
      } else {
        delete next[field]
      }
      changed = true
      continue
    }
    if (isMap(before[field]) && (isMap(after[field]) || after[field] === undefined)) {
      if (current === undefined) {
        continue
      }
      if (!isMap(current)) {
        throw replayConflict(field)
      }
      const original = before[field] as JsonMap
      const retired = (after[field] ?? {}) as JsonMap
      const map = { ...current }
      for (const key of new Set([...Object.keys(original), ...Object.keys(retired)])) {
        if (equal(original[key], retired[key]) || equal(map[key], retired[key])) {
          continue
        }
        if (!equal(map[key], original[key])) {
          throw replayConflict(field, original[key], map[key])
        }
        if (Object.hasOwn(retired, key)) {
          map[key] = structuredClone(retired[key])
        } else {
          delete map[key]
        }
        changed = true
      }
      next[field] = map
    } else if (
      Array.isArray(before[field]) &&
      (Array.isArray(after[field]) || after[field] === undefined)
    ) {
      if (current === undefined) {
        continue
      }
      if (!Array.isArray(current)) {
        throw replayConflict(field)
      }
      const retired = (after[field] ?? []) as unknown[]
      const removed = (before[field] as unknown[]).filter(
        (entry) => !retired.some((candidate) => equal(entry, candidate))
      )
      const filtered = current.filter(
        (entry) => !removed.some((candidate) => equal(entry, candidate))
      )
      if (filtered.length !== current.length) {
        next[field] = filtered
        changed = true
      }
    }
    // New scalar selections survive; the installed-state proof still rejects source references.
  }
  return changed ? (next as WorkspaceSessionState) : session
}
