import { isRuntimePathAbsolute } from '../../shared/cross-platform-path'
import { isReasonixStorageSessionId } from '../../shared/reasonix-session-paths'
import { extractString, parseJsonObject } from './session-scanner-values'

export type ReasonixManifest = {
  sessionId: string
  createdAt: string
  contentRoot: '../.content-v1' | '.content-v1'
}

function metadataRecord(bytes: Buffer): Record<string, unknown> {
  if (bytes.length > 64 * 1024) {
    throw new Error('Reasonix metadata exceeds read budget')
  }
  const record = parseJsonObject(bytes.toString('utf8'))
  if (!record) {
    throw new Error('Invalid Reasonix metadata')
  }
  return record
}

function createdAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    value.startsWith('0001-01-01T00:00:00') ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error('Invalid Reasonix metadata timestamp')
  }
  return value
}

// Read-only revision 3; native migration and prototype conversion remain provider-owned.
export function parseReasonixManifest(bytes: Buffer, sessionId: string): ReasonixManifest {
  const record = metadataRecord(bytes)
  if (
    record.schemaVersion !== 4 ||
    record.codec !== 'reasonix.session.linear/v4' ||
    record.storageRevision !== 3
  ) {
    throw new Error('Unsupported Reasonix history format; update the transcript-owning Orca host')
  }
  if (record.sessionId !== sessionId || !isReasonixStorageSessionId(sessionId)) {
    throw new Error('Reasonix manifest identity mismatch')
  }
  const contentRoot = record.contentRoot ?? '../.content-v1'
  if (contentRoot !== '../.content-v1' && contentRoot !== '.content-v1') {
    throw new Error('Unsupported Reasonix content store location')
  }
  return { sessionId, createdAt: createdAt(record.createdAt), contentRoot }
}

// Optional Desktop ownership metadata; current CLI sessions legitimately omit it.
export function parseReasonixWorkspaceHeader(bytes: Buffer, sessionId: string): string | null {
  const record = metadataRecord(bytes)
  if (
    record.schemaVersion !== 1 ||
    record.sessionId !== sessionId ||
    !isReasonixStorageSessionId(sessionId) ||
    (record.cwd != null && typeof record.cwd !== 'string') ||
    !['new', 'fork', 'canonical-v4-import', 'legacy-import'].includes(String(record.origin)) ||
    (record.parentSessionId != null &&
      (typeof record.parentSessionId !== 'string' ||
        (record.parentSessionId !== '' && !isReasonixStorageSessionId(record.parentSessionId))))
  ) {
    throw new Error('Invalid Reasonix workspace ownership header')
  }
  createdAt(record.createdAt)
  const cwd = extractString(record.cwd)
  if (cwd && !isRuntimePathAbsolute(cwd)) {
    throw new Error('Reasonix workspace ownership must be absolute')
  }
  return cwd
}
