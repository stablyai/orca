import type {
  AgentJournalRenderItem,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { ProviderTimelineTextChannel } from './provider-timeline-event'
import type { ProviderTimelineRowId } from './provider-timeline-rows'
import { JOURNAL_TEXT_TAIL_WRITES } from '../agent-session-journal/journal-text-tail-writes'

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

/** Whether a stream's text is live (unsaved) in `epoch`, given whether it has buffered text. */
export function providerTimelineTextIsLive(
  stream: ProviderTimelineStream,
  epoch: string,
  buffered: boolean
): boolean {
  return (
    stream.committed?.epoch === epoch && buffered && !stream.closing && stream.stoppedIn === null
  )
}

/** Whether any of `streams` has live text, without joining any stream's buffered text. */
export function providerTimelineHasLiveText(
  streams: Iterable<ProviderTimelineStream>,
  epoch: string,
  buffered: (id: string) => boolean
): boolean {
  for (const stream of streams) {
    if (providerTimelineTextIsLive(stream, epoch, buffered(stream.id))) {
      return true
    }
  }
  return false
}

export function providerTimelineLiveText(
  stream: ProviderTimelineStream,
  epoch: string,
  snapshot: { text: string } | null
): AgentJournalRenderItem[] {
  const committed = stream.committed
  return !committed || !snapshot || !providerTimelineTextIsLive(stream, epoch, true)
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

/** One save of a stream's text; `final` is its last, which folds any appended tail. */
export function providerTimelineTextResolution(
  stream: ProviderTimelineStream,
  text: string,
  final: boolean
) {
  return {
    kind: 'text-snapshot' as const,
    identity: stream.row.identity,
    body: providerTimelineTextBody(stream, text),
    scopeItemIds: stream.scopeItemIds,
    ...(final ? { final: true as const } : {})
  }
}

/** Close saves owed text; with tails on, also one last whole save that folds the saved tail. */
export function providerTimelineCloseSaves(stream: ProviderTimelineStream, owed: number): boolean {
  return owed !== stream.queuedLength || (JOURNAL_TEXT_TAIL_WRITES && stream.queuedLength > 0)
}
