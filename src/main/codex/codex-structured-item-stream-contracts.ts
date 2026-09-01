import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { codexJournalItem, CodexThreadItem } from './codex-structured-item-translation'

export type CodexItemStreamDeps = {
  sink: StructuredAgentSessionEventSink
  identityFor: (
    threadId: string,
    params: unknown,
    item: CodexThreadItem
  ) => AgentJournalItemIdentity
  coalesceMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

export type CodexItemStreamState = {
  identity: AgentJournalItemIdentity
  item: CodexThreadItem
}

export type CodexPendingItemPatch = {
  identity: AgentJournalItemIdentity
  body: NonNullable<ReturnType<typeof codexJournalItem>['body']>
  blobs: ReturnType<typeof codexJournalItem>['blobs']
}

export type CodexStructuredItemStreamAdmission =
  | { accepted: true }
  | { accepted: false; reason: 'backpressure' | 'failed' | 'closed' }

export type CodexStructuredItemStreamHandleResult = {
  handled: boolean
  admission: CodexStructuredItemStreamAdmission
}

export type CodexStructuredItemStreams = {
  track: (threadId: string, item: CodexThreadItem, identity: AgentJournalItemIdentity) => void
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
