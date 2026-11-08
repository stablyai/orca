import type {
  AgentJournalRenderItem,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { ProviderTimelineTextChannel } from './provider-timeline-event'
import type { ProviderTimelineRowId } from './provider-timeline-rows'

export type ProviderTimelineStream = {
  id: string
  /** Named deltas and snapshots share the same row identity. */
  key: string
  row: ProviderTimelineRowId
  /** New rows use this scope; existing rows retain theirs. */
  scope: AgentJournalTurnScope
  scopeItemIds?: readonly string[]
  named: boolean
  channel: ProviderTimelineTextChannel
  producer: AgentJournalProducerLinkage | undefined
  /** Only the committed envelope is retained alongside the coalescer's one text buffer. */
  committed: { epoch: string; placement: Omit<AgentJournalRenderItem, 'body'> } | null
  queuedLength: number
  savedAt: number
  pending: number
  closing: boolean
  /** Once a write finds a settled turn, later text cannot land. */
  stoppedIn: string | null
}

export function providerTimelineLiveText(
  stream: ProviderTimelineStream,
  epoch: string,
  snapshot: { text: string } | null
): AgentJournalRenderItem[] {
  const committed = stream.committed
  return !committed ||
    committed.epoch !== epoch ||
    !snapshot ||
    stream.closing ||
    stream.stoppedIn !== null
    ? []
    : [
        {
          ...committed.placement,
          body: providerTimelineTextBody(stream, snapshot.text)
        }
      ]
}

export function providerTimelineTextBody(
  stream: ProviderTimelineStream,
  text: string
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: stream.channel === 'assistant' ? 'assistant' : 'reasoning',
    blocks: [{ type: 'text', text }]
  }
}
