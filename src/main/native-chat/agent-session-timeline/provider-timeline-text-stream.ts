import type {
  AgentJournalRenderItem,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { ProviderTimelineTextChannel } from './provider-timeline-event'
import type { ProviderTimelineRowId } from './provider-timeline-rows'
import { JOURNAL_TEXT_TAIL_WRITES } from '../agent-session-journal/journal-text-tail-writes'
import { noteReplyTextGrowth } from '../../../shared/agent-session/view/live-read/agent-session-text-append'

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
  readSnapshot: () => { text: string } | null,
  /** A row no reader takes is not read. */
  takes?: (itemId: string) => boolean
): AgentJournalRenderItem[] {
  const committed = stream.committed
  if (!committed || takes?.(committed.placement.itemId) === false) {
    return []
  }
  if (committed.epoch !== epoch || stream.closing || stream.stoppedIn !== null) {
    return []
  }
  const snapshot = readSnapshot()
  if (!snapshot) {
    return []
  }
  const last = lastLiveRow.get(stream)
  const same = last?.placement === committed.placement
  if (same && last.length === snapshot.text.length) {
    return [last.item]
  }
  const item = { ...committed.placement, body: providerTimelineTextBody(stream, snapshot.text) }
  // Compared once here, so each reader's check that it extends what it holds is a reference compare.
  noteReplyTextGrowth(item, same ? last.item : undefined)
  lastLiveRow.set(stream, { placement: committed.placement, length: snapshot.text.length, item })
  return [item]
}

/** Each stream's last live row, reused while its text is unchanged. */
const lastLiveRow = new WeakMap<
  ProviderTimelineStream,
  { placement: object; length: number; item: AgentJournalRenderItem }
>()

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
