export const CONVERSATION_WAKE_ID_MAX_LENGTH = 512

export const CONVERSATION_WAKE_MESSAGE_TYPES = [
  'worker_done',
  'escalation',
  'decision_gate',
  'question'
] as const

export type ConversationWakeMessageType = (typeof CONVERSATION_WAKE_MESSAGE_TYPES)[number]

export function isBoundedConversationWakeId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= CONVERSATION_WAKE_ID_MAX_LENGTH
  )
}
