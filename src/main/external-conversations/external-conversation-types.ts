import type { ConnectorSource } from '../../shared/external-conversation-link'

export type ConversationKey = { source: ConnectorSource; externalId: string }

export const CONNECTOR_REFUSALS = [
  'connectors_disabled',
  'agent_not_reachable',
  'unsupported_agent',
  'delivery_id_reused',
  'delivery_backlog_full',
  'agent_asleep_in_window',
  'no_session_to_reopen',
  'reopen_refused',
  // An answer's: the prompt was answered or moved on, only Orca can answer it, or no such option.
  'prompt_not_pending',
  'prompt_unsupported',
  'option_not_offered',
  // Queued or held work a cancel settled before it was written.
  'conversation_cancelled'
] as const
export type ConnectorRefusal = (typeof CONNECTOR_REFUSALS)[number]

/** accepted confirms writer completion, not agent receipt; reopened marks a resumed session before delivery. */
export type Delivery =
  | { outcome: 'accepted'; reopened?: true }
  | { outcome: 'refused'; reason: ConnectorRefusal }
  | {
      outcome: 'unknown'
      reason: 'launch_outcome_unknown' | 'writer_failed' | 'replayed_after_restart'
    }

export type ConversationStart = { conversation: ConversationKey; initial: Delivery }

export function refused(reason: ConnectorRefusal): Delivery {
  return { outcome: 'refused', reason }
}

// Encode the pair structurally to avoid collisions when IDs contain delimiters.
export function conversationId(key: ConversationKey): string {
  return JSON.stringify([key.source, key.externalId])
}
