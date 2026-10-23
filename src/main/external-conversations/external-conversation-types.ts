import type { ConnectorSource } from '../../shared/external-conversation-link'

export type ConversationKey = { source: ConnectorSource; externalId: string }

/** Why the seam declined before any byte left it. */
export const CONNECTOR_REFUSALS = [
  'connectors_disabled',
  'agent_not_reachable',
  'unsupported_agent',
  'delivery_id_reused',
  'delivery_backlog_full',
  // The three a closed agent's reopen ends on; each asks the user to open it in Orca.
  'agent_asleep_in_window',
  'no_session_to_reopen',
  'reopen_refused'
] as const
export type ConnectorRefusal = (typeof CONNECTOR_REFUSALS)[number]

/**
 * The connector's own answer, weaker than a `WriteSettlement`: `accepted` means the writer
 * returned, never that the agent read it. `reopened`: the agent had exited or its tab was closed,
 * so it was resumed in its workspace before the write.
 */
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

/** One string per conversation, unambiguous for any id text. */
export function conversationId(key: ConversationKey): string {
  return JSON.stringify([key.source, key.externalId])
}
