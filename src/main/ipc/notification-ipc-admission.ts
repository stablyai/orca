import type { NotificationDispatchRequest } from '../../shared/types'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const MAX_NOTIFICATION_DISPATCH_INPUT_BYTES = 256 * 1024
export const MAX_NOTIFICATION_ID_BYTES = 8 * 1024
export const MAX_NOTIFICATION_WORKTREE_ID_BYTES = 16 * 1024
export const MAX_NOTIFICATION_PANE_KEY_BYTES = 8 * 1024
export const MAX_NOTIFICATION_DISMISS_IDS = 256
export const MAX_NOTIFICATION_DISMISS_SCAN_ENTRIES = 1_024
export const MAX_NOTIFICATION_DISMISS_TOTAL_ID_BYTES = 256 * 1024

const STRING_FIELDS = [
  'notificationId',
  'worktreeId',
  'paneKey',
  'repoLabel',
  'worktreeLabel',
  'terminalTitle',
  'agentType',
  'agentState',
  'agentPrompt',
  'agentToolName',
  'agentToolInput',
  'agentLastAssistantMessage'
] as const

const BOOLEAN_FIELDS = [
  'requireDisplayConfirmation',
  'hasMultipleActiveRepos',
  'isActiveWorktree',
  'agentInterrupted'
] as const

function stringLimit(field: (typeof STRING_FIELDS)[number]): number {
  if (field === 'notificationId') {
    return MAX_NOTIFICATION_ID_BYTES
  }
  if (field === 'worktreeId') {
    return MAX_NOTIFICATION_WORKTREE_ID_BYTES
  }
  if (field === 'paneKey') {
    return MAX_NOTIFICATION_PANE_KEY_BYTES
  }
  return MAX_NOTIFICATION_DISPATCH_INPUT_BYTES
}

export function normalizeNotificationDispatchRequest(
  value: unknown
): NotificationDispatchRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const request = value as Record<string, unknown>
  if (
    request.source !== 'agent-task-complete' &&
    request.source !== 'terminal-bell' &&
    request.source !== 'test'
  ) {
    return null
  }

  const normalized: Record<string, unknown> = { source: request.source }
  let retainedBytes = measureUtf8ByteLength(request.source).byteLength
  for (const field of STRING_FIELDS) {
    const fieldValue = request[field]
    if (fieldValue === undefined || fieldValue === null) {
      continue
    }
    if (typeof fieldValue !== 'string') {
      return null
    }
    const remaining = Math.min(
      stringLimit(field),
      MAX_NOTIFICATION_DISPATCH_INPUT_BYTES - retainedBytes
    )
    const measured = measureUtf8ByteLength(fieldValue, { stopAfterBytes: remaining })
    if (measured.exceededLimit) {
      return null
    }
    retainedBytes += measured.byteLength
    normalized[field] = fieldValue
  }
  for (const field of BOOLEAN_FIELDS) {
    const fieldValue = request[field]
    if (fieldValue === undefined) {
      continue
    }
    if (typeof fieldValue !== 'boolean') {
      return null
    }
    normalized[field] = fieldValue
  }
  return normalized as NotificationDispatchRequest
}

export function boundedUniqueNotificationDismissIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const ids: string[] = []
  const unique = new Set<string>()
  let retainedBytes = 0
  const scanCount = Math.min(value.length, MAX_NOTIFICATION_DISMISS_SCAN_ENTRIES)
  for (let index = 0; index < scanCount && ids.length < MAX_NOTIFICATION_DISMISS_IDS; index++) {
    const id = value[index]
    if (typeof id !== 'string' || id.length === 0 || unique.has(id)) {
      continue
    }
    const remaining = Math.min(
      MAX_NOTIFICATION_ID_BYTES,
      MAX_NOTIFICATION_DISMISS_TOTAL_ID_BYTES - retainedBytes
    )
    const measured = measureUtf8ByteLength(id, { stopAfterBytes: remaining })
    if (measured.exceededLimit) {
      continue
    }
    unique.add(id)
    ids.push(id)
    retainedBytes += measured.byteLength
  }
  return ids
}
