// Share provider boundary predicates so visible interruption rows and lifecycle settlement agree.

import { extractString } from '../ai-vault/session-scanner-values'

export function claudeInterruptedMessageId(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'user') {
    return undefined
  }
  return extractString(record.interruptedMessageId) ?? undefined
}

export const CODEX_EVENT_TURN_STARTED = 'task_started'
export const CODEX_EVENT_TURN_COMPLETE = 'task_complete'
export const CODEX_EVENT_TURN_ABORTED = 'turn_aborted'
