import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import type { ClickUpTaskUpdate } from '../../../shared/clickup/clickup-types'

export function normalizeClickUpString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Narrows an untrusted IPC payload to the task-update fields the host accepts. */
export function normalizeClickUpTaskUpdate(value: unknown): ClickUpTaskUpdate {
  const raw = isRecord(value) ? value : {}
  const status = normalizeClickUpString(raw.status)
  return status ? { status } : {}
}
