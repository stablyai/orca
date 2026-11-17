import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemCommitted
} from './structured-agent-session-event-sink'

type Placement = { epoch: string; row: Omit<AgentJournalRenderItem, 'body'> }

/** Streamed rows shown with their newest text at the placement their last save committed, so
 *  display never waits on a save. A row appears only once its first save lands. */
export class StructuredAgentSessionLiveTextRows {
  private readonly placements = new Map<string, Placement | null>()
  private readonly release: (() => void) | undefined

  constructor(
    private readonly sink: Pick<
      StructuredAgentSessionEventSink,
      'bindLiveText' | 'publishLiveText'
    >,
    private readonly body: (key: string) => AgentJournalItemBody | null
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
  }

  dispose(): void {
    this.placements.clear()
    this.release?.()
  }

  private read(epoch: string): AgentJournalRenderItem[] {
    const items: AgentJournalRenderItem[] = []
    for (const [key, placement] of this.placements) {
      const body = placement?.epoch === epoch ? this.body(key) : null
      if (placement && body) {
        items.push({ ...placement.row, body })
      }
    }
    return items
  }
}
