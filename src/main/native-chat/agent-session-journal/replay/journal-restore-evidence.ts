import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemSubagentId } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalRow, JournalStopEvent } from '../durable-rows/journal-row-schema'
import type { JournalReducerState } from '../projection/journal-reducer'
import { resolveJournalItemId } from '../projection/journal-item-echo'
import { journalItemProvenance } from '../projection/journal-item-provenance'

export type HistoricalJournalItemRevision = {
  sequence: number
  item: AgentJournalRenderItem | null
  ownerFence?: number
  executionOwner?: number
  settlementIds: readonly string[]
}

/** Temporary evidence observes the admitted restore fold, never interprets rows independently. */
export class JournalRestoreEvidence {
  readonly revisions = new Map<string, HistoricalJournalItemRevision[]>()
  readonly answers = new Map<string | null, number>()
  readonly stops: { sequence: number; event: JournalStopEvent }[] = []
  through = 0
  sourceIdentity: string | null = null

  constructor(private readonly collectRequests: boolean) {}

  observe = (row: JournalRow, state: JournalReducerState): void => {
    this.through = row.seq
    if (row.kind === 'tombstone' && row.stopEvent) {
      this.stops.push({ sequence: row.seq, event: row.stopEvent })
    }
    if (!this.collectRequests) {
      return
    }
    const changed =
      row.kind === 'item' || row.kind === 'tombstone'
        ? [row.itemId]
        : row.kind === 'lifecycle-batch'
          ? row.mutations.map((mutation) => mutation.itemId)
          : []
    for (const changedId of changed) {
      const id = resolveJournalItemId(state, changedId)
      const item = state.items.get(id) ?? null
      let history = this.revisions.get(id)
      if (
        !history &&
        item &&
        (item.body.kind === 'question' ||
          item.body.kind === 'approval' ||
          readAgentJournalTurn(item.body))
      ) {
        history = []
        this.revisions.set(id, history)
      }
      if (!history || item === history.at(-1)?.item) {
        continue
      }
      history.push({
        sequence: row.seq,
        item,
        ...journalItemProvenance(state, id),
        settlementIds: row.kind === 'lifecycle-batch' ? [row.settlementId] : []
      })
      if (
        item &&
        (item.body.kind === 'question' || item.body.kind === 'approval') &&
        item.body.resolution.state === 'resolved'
      ) {
        const stream = agentJournalItemSubagentId(item)
        this.answers.set(stream, Math.max(this.answers.get(stream) ?? 0, row.seq))
      }
    }
  }
}
