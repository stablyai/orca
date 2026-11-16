import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionDeltaCoalescerDeps } from '../../../native-chat/agent-session-wire/publication/subscribers/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { codexJournalItem } from './codex-structured-item-translation'
import type { CodexThreadItem } from './codex-thread-item-identity'
import type { CodexRowAttribution } from '../background-work/codex-subagent-linkage'

export type CodexItemStreamDeps = {
  sink: StructuredAgentSessionEventSink
  /** Resolve turn provenance from the first delta. */
  turnIdFor: (threadId: string, params: unknown) => string | null
  identityFor: (
    threadId: string,
    turnId: string | null,
    item: CodexThreadItem
  ) => AgentJournalItemIdentity
  attributionFor: CodexRowAttribution
  coalesceMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

export type CodexItemStreamState = {
  identity: AgentJournalItemIdentity
  item: CodexThreadItem
  /** Host start time for rows first written by a stream. */
  startedAt?: number
}

export type CodexPendingItemPatch = {
  identity: AgentJournalItemIdentity
  body: NonNullable<ReturnType<typeof codexJournalItem>['body']>
}

export type CodexStructuredItemStreamAdmission =
  | { accepted: true }
  | { accepted: false; reason: 'backpressure' | 'failed' | 'closed' }

export type CodexStructuredItemStreamHandleResult = {
  handled: boolean
  admission: CodexStructuredItemStreamAdmission
}

export type CodexStructuredItemStreams = {
  readonly persistentCount: number
  track: (
    threadId: string,
    turnId: string | null,
    item: CodexThreadItem,
    identity: AgentJournalItemIdentity,
    startedAt?: number
  ) => void
  handle: (
    threadId: string,
    method: string,
    params: unknown
  ) => CodexStructuredItemStreamHandleResult
  forget: (threadId: string, itemId: string) => void
  /** Force-saves streamed text before a row; a thread limits that to its own streams, the only text its row follows. */
  flush: (threadId?: string) => boolean
  dispose: () => void
  snapshot: (
    threadId: string,
    itemId: string
  ) => { text: string; observedBytes: number; truncated: boolean } | null
}
