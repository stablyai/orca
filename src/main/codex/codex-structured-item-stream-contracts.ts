import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { codexJournalItem, CodexThreadItem } from './codex-structured-item-translation'
import type { CodexRowAttribution } from './codex-subagent-linkage'

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
  flush: () => boolean
  dispose: () => void
  snapshot: (
    threadId: string,
    itemId: string
  ) => { text: string; observedBytes: number; truncated: boolean } | null
}
