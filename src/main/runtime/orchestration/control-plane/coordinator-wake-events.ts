import type { MessageRow, MessageType } from '../types'

/** B3 — the coordinator subscribes once and yields. These are the only reasons
 *  the runtime wakes it. A timeout with no event is explicitly NOT a wake:
 *  `selectWakeEvents([])` returns an empty list and the caller keeps waiting.
 *
 *  STALLED, CRASHED, REVIEW_COMPLETE and CI_BLOCKER have no message-type of
 *  their own — extending the messages CHECK constraint would break every older
 *  reader of the same database. They travel as `escalation` rows carrying a
 *  typed `wakeReason` in the payload, so an old client still sees a real
 *  escalation while a current one gets the exact reason.
 */
export const COORDINATOR_WAKE_REASONS = [
  'worker_done',
  'question',
  'escalation',
  'stalled',
  'crashed',
  'review_complete',
  'ci_blocker'
] as const

export type CoordinatorWakeReason = (typeof COORDINATOR_WAKE_REASONS)[number]

/** The message-type projection of the wake set — what a subscription filters on. */
export const COORDINATOR_WAKE_MESSAGE_TYPES: readonly MessageType[] = [
  'worker_done',
  'question',
  'escalation'
]

export const WAKE_REASON_PAYLOAD_KEY = 'wakeReason'

export function isCoordinatorWakeReason(value: unknown): value is CoordinatorWakeReason {
  return (
    typeof value === 'string' && (COORDINATOR_WAKE_REASONS as readonly string[]).includes(value)
  )
}

function readWakeReasonPayload(payload: string | null): CoordinatorWakeReason | undefined {
  if (!payload) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    const raw = (parsed as Record<string, unknown>)[WAKE_REASON_PAYLOAD_KEY]
    return isCoordinatorWakeReason(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

/** Null means "do not wake the coordinator for this row". */
export function classifyWakeReason(
  message: Pick<MessageRow, 'type' | 'payload'>
): CoordinatorWakeReason | null {
  switch (message.type) {
    case 'worker_done':
      return 'worker_done'
    case 'question':
      return 'question'
    case 'escalation':
      return readWakeReasonPayload(message.payload) ?? 'escalation'
    case 'status':
    case 'dispatch':
    case 'merge_ready':
    case 'handoff':
    case 'decision_gate':
    case 'heartbeat':
      return null
  }
}

export type CoordinatorWakeEvent = {
  reason: CoordinatorWakeReason
  messageId: string
  sequence: number
}

export function selectWakeEvents(
  messages: readonly Pick<MessageRow, 'id' | 'type' | 'payload' | 'sequence'>[]
): CoordinatorWakeEvent[] {
  const events: CoordinatorWakeEvent[] = []
  for (const message of messages) {
    const reason = classifyWakeReason(message)
    if (reason) {
      events.push({ reason, messageId: message.id, sequence: message.sequence })
    }
  }
  return events
}

/** A wait that produced no wake event must not return control to the model —
 *  there is nothing for it to act on and a continuation loop is exactly what B3
 *  removes. */
export function shouldWakeCoordinator(
  messages: readonly Pick<MessageRow, 'id' | 'type' | 'payload' | 'sequence'>[]
): boolean {
  return selectWakeEvents(messages).length > 0
}
