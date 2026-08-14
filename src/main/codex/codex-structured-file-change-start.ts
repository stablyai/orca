import { digestStructuredValue } from './codex-structured-write-digest'
import { parseFileChanges } from './codex-structured-write-manifest'
import type {
  CodexObservedFileChange,
  CodexStructuredWriteLease
} from './codex-structured-write-types'
import { structuredWriteItemKey } from './codex-structured-write-turn-lifecycle'

export function observeStructuredFileChangeStart(input: {
  sessionId: string
  params: unknown
  lease: CodexStructuredWriteLease | undefined
  fileChanges: Map<string, CodexObservedFileChange>
}): CodexObservedFileChange | null {
  const record = asRecord(input.params)
  const item = asRecord(record.item)
  if (item.type !== 'fileChange' || typeof item.id !== 'string') {
    return null
  }
  const threadId = readString(record, 'threadId')
  const turnId = readString(record, 'turnId')
  const changes = parseFileChanges(item.changes)
  if (!threadId || !turnId || !changes) {
    return null
  }
  const key = structuredWriteItemKey(input.sessionId, item.id)
  const changePlanDigest = digestStructuredValue(changes)
  const existing = input.fileChanges.get(key)
  if (existing) {
    return existing.threadId === threadId &&
      existing.turnId === turnId &&
      existing.changePlanDigest === changePlanDigest
      ? null
      : existing
  }
  if (
    !input.lease ||
    input.lease.state !== 'issued' ||
    input.lease.threadId !== threadId ||
    input.lease.turnId !== turnId
  ) {
    return null
  }
  input.fileChanges.set(key, {
    sessionId: input.sessionId,
    threadId,
    turnId,
    itemId: item.id,
    changes,
    changePlanDigest,
    before: null,
    admission: null
  })
  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
