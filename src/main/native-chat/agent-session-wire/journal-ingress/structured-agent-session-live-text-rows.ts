import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemCommitted
} from './structured-agent-session-event-sink'
import { CHAT_LIVE_TEXT_SUBSCRIBER_BYTES } from '../../retention/subscriber-live-text-cap'

/** Characters of live text one stream offers. Two snapshots (one sending, one waiting) at two bytes
 *  a character stay well inside a viewer's cap, so a long reply never ends its viewers' streams;
 *  rows past it update on their saves alone. */
const LIVE_TEXT_STREAM_MAX_CHARS = CHAT_LIVE_TEXT_SUBSCRIBER_BYTES / 8

type Placement = { epoch: string; row: Omit<AgentJournalRenderItem, 'body'> }

/** Streamed rows shown with their newest text at the placement their last save committed, so
 *  display never waits on a save. A row appears only once its first save lands. */
export class StructuredAgentSessionLiveTextRows {
  private readonly placements = new Map<string, Placement | null>()
  // An unchanged row keeps its object, so its wire form and a subscriber's last send are reused.
  private readonly shown = new Map<
    string,
    { placement: Placement; length: number; item: AgentJournalRenderItem }
  >()
  private readonly release: (() => void) | undefined

  constructor(
    private readonly sink: Pick<
      StructuredAgentSessionEventSink,
      'bindLiveText' | 'publishLiveText'
    >,
    private readonly text: (key: string) => string | undefined,
    private readonly body: (key: string, text: string) => AgentJournalItemBody | null
  ) {
    // Translators own lifecycle flushes; a write barrier must not force saves of streaming rows.
    this.release = sink.bindLiveText?.({ read: (epoch) => this.read(epoch), flush: () => {} })
  }

  /** Pass to the save; a late commit for a forgotten row is ignored. */
  committed(key: string): StructuredAgentSessionItemCommitted {
    if (!this.placements.has(key)) {
      this.placements.set(key, null)
    }
    return (item, epoch) => {
      if (this.placements.has(key)) {
        const { body: _body, ...row } = item
        this.placements.set(key, { epoch, row })
      }
    }
  }

  publish(): void {
    this.sink.publishLiveText?.()
  }

  forget(key: string): void {
    this.placements.delete(key)
    this.shown.delete(key)
  }

  dispose(): void {
    this.placements.clear()
    this.shown.clear()
    this.release?.()
  }

  private read(epoch: string): AgentJournalRenderItem[] {
    const items: AgentJournalRenderItem[] = []
    let budget = LIVE_TEXT_STREAM_MAX_CHARS
    for (const [key, placement] of this.placements) {
      const text = placement?.epoch === epoch ? this.text(key) : undefined
      if (!placement || text === undefined || text.length > budget) {
        continue
      }
      budget -= text.length
      const shown = this.shown.get(key)
      if (shown?.placement === placement && shown.length === text.length) {
        items.push(shown.item)
        continue
      }
      const body = this.body(key, text)
      if (body) {
        const item = { ...placement.row, body }
        this.shown.set(key, { placement, length: text.length, item })
        items.push(item)
      }
    }
    return items
  }
}
