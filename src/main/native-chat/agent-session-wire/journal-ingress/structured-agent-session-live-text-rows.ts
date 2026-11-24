import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemCommitted,
  LiveTextReaders
} from './structured-agent-session-event-sink'
import { CHAT_LIVE_TEXT_SUBSCRIBER_BYTES } from '../../retention/subscriber-live-text-cap'
import {
  noteKnownReplyTextGrowth,
  noteReplyTextGrowth
} from '../../../../shared/agent-session/view/live-read/agent-session-text-append'

/** Characters of live text one stream offers. Two snapshots (one sending, one waiting) at two bytes
 *  a character stay well inside a viewer's cap, so a long reply never ends its viewers' streams;
 *  rows past it update on their saves alone. */
const LIVE_TEXT_STREAM_MAX_CHARS = CHAT_LIVE_TEXT_SUBSCRIBER_BYTES / 8

/** Rows this class shows below the save rule: whole each window they would resend the reply, so
 *  only a reader that takes appends gets them; any other waits for the saves, as before. */
const appendOnlyRows = new WeakSet<AgentJournalRenderItem>()

export function isAppendOnlyLiveRow(item: AgentJournalRenderItem): boolean {
  return appendOnlyRows.has(item)
}

type Placement = { epoch: string; row: Omit<AgentJournalRenderItem, 'body'> }

/** Streamed rows shown with their newest text at the placement their last save committed, so
 *  display never waits on a save. A row appears only once its first save lands. */
export class StructuredAgentSessionLiveTextRows {
  private readonly placements = new Map<string, Placement | null>()
  // An unchanged row keeps its object, so its wire form and a subscriber's last send are reused.
  private readonly shown = new Map<
    string,
    {
      placement: Placement
      length: number
      item: AgentJournalRenderItem
      text: string
      stream: object | undefined
    }
  >()
  private readonly release: (() => void) | undefined

  constructor(
    private readonly sink: Pick<
      StructuredAgentSessionEventSink,
      'bindLiveText' | 'publishLiveText'
    >,
    /** The row's text, or undefined when it is longer than `maxLength` (read without copying it). */
    private readonly text: (key: string, maxLength: number) => string | undefined,
    private readonly body: (key: string, text: string) => AgentJournalItemBody | null,
    /** The source's stream for a row; a longer read of the same one extends the last. */
    private readonly streamOf?: (key: string) => object | undefined
  ) {
    // Translators own lifecycle flushes; a write barrier must not force saves of streaming rows.
    this.release = sink.bindLiveText?.({
      read: (epoch, readers) =>
        readers?.appends === false || readers?.shown === false ? [] : this.read(epoch, readers),
      flush: () => {}
    })
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

  private read(epoch: string, readers?: LiveTextReaders): AgentJournalRenderItem[] {
    const items: AgentJournalRenderItem[] = []
    let budget = LIVE_TEXT_STREAM_MAX_CHARS
    for (const [key, placement] of this.placements) {
      if (!placement) {
        continue
      }
      const { itemId } = placement.row
      const wanted = readers?.takes?.(itemId) !== false && readers?.awaitsBase?.(itemId) !== true
      const text = wanted && placement.epoch === epoch ? this.text(key, budget) : undefined
      if (text === undefined) {
        continue
      }
      budget -= text.length
      const shown = this.shown.get(key)
      const stream = this.streamOf?.(key)
      if (
        shown?.placement === placement &&
        shown.length === text.length &&
        shown.stream === stream
      ) {
        items.push(shown.item)
        continue
      }
      const body = this.body(key, text)
      if (body) {
        const item = { ...placement.row, body }
        appendOnlyRows.add(item)
        if (shown?.placement === placement && stream !== undefined && shown.stream === stream) {
          // The same append-only stream read longer: it extends the last read without a scan.
          noteKnownReplyTextGrowth(item, text, shown.item, shown.text)
        } else {
          noteReplyTextGrowth(item, shown?.placement === placement ? shown.item : undefined)
        }
        this.shown.set(key, { placement, length: text.length, item, text, stream })
        items.push(item)
      }
    }
    return items
  }
}
