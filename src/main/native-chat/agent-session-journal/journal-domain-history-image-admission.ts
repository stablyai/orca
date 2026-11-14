import type Database from '../../sqlite/sync-database'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  historyContentBytes,
  submissionBytesByItemId,
  type HistoryItemForm,
  type HistoryReader
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import type { JournalOutcomeReadRow } from './replay/journal-read-row'
import type { JournalDomainHistoryHead } from './journal-domain-history-page'
import { readJournalDomainStopStates } from './journal-domain-item-display'

export type JournalDomainHistorySnapshotReader = (
  ids: Set<string>,
  forms: Map<string, HistoryItemForm>,
  states?: ReadonlyMap<string, unknown>,
  ordinals?: Map<string, number>,
  orderedIds?: readonly string[]
) => AgentJournalSnapshot

const eventIds = (row: JournalOutcomeReadRow) => [
  ...row.itemIds,
  ...row.submissionIds.map(agentJournalSubmissionKey)
]

/** Exact prefix admission stops body reads before applying the shared reader's same halving rule. */
export function admitJournalDomainImageEvents(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  rows: readonly JournalOutcomeReadRow[],
  reader: Pick<HistoryReader, 'form' | 'budgetBytes'>,
  readSnapshot: JournalDomainHistorySnapshotReader
): {
  limit: number
  snapshot: AgentJournalSnapshot
  forms: ReadonlyMap<AgentJournalSnapshot['items'][number], HistoryItemForm>
} {
  const states = readJournalDomainStopStates(db, head, [...new Set(rows.flatMap(eventIds))])
  const items = new Map<string, AgentJournalSnapshot['items'][number]>()
  const forms = new Map<AgentJournalSnapshot['items'][number], HistoryItemForm>()
  const submissions = new Map<string, AgentJournalSnapshot['submissions'][number]>()
  const ordinals = new Map<string, number>()
  const visited = new Set<string>()
  let count = 0
  let total = 0
  for (const row of rows) {
    const fresh = [...new Set(eventIds(row))].filter((id) => !visited.has(id))
    const group = readSnapshot(new Set(fresh), new Map(), states, ordinals)
    const live = new Map(
      group.items.map((item) => {
        const form = reader.form(item)
        // Keep selection identity/order without retaining a larger pre-presentation source.
        const retained = {
          ...form.item,
          itemId: item.itemId,
          sequence: item.sequence,
          sequenceIndex: item.sequenceIndex
        }
        return [item.itemId, { retained, form }] as const
      })
    )
    const bytes = historyContentBytes(
      [...live.values()].map(({ form }) => form),
      fresh.filter((id) => !live.has(id)),
      submissionBytesByItemId(group.submissions)
    )
    if (count > 0 && total + bytes > reader.budgetBytes) {
      break
    }
    for (const [id, { retained, form }] of live) {
      items.set(id, retained)
      forms.set(retained, form)
    }
    for (const send of group.submissions) {
      submissions.set(send.clientMessageId, send)
    }
    for (const id of fresh) {
      visited.add(id)
    }
    count++
    total += bytes
    if (total > reader.budgetBytes) {
      break
    }
  }
  // Touched identities only accumulate, so the first non-fit determines every halved prefix.
  const limit = halvedJournalDomainEventLimit(rows.length, count)
  const kept = new Set(rows.slice(0, limit).flatMap(eventIds))
  return {
    limit: Math.max(1, limit),
    forms,
    snapshot: {
      sessionId: head.sessionId,
      cursor: head.cursor,
      items: [...items.values()].filter((item) => kept.has(item.itemId)),
      submissions: [...submissions.values()]
        .filter((send) => kept.has(agentJournalSubmissionKey(send.clientMessageId)))
        .sort(
          (a, b) =>
            a.submittedAt - b.submittedAt ||
            ordinals.get(a.clientMessageId)! - ordinals.get(b.clientMessageId)!
        )
    }
  }
}

export function halvedJournalDomainEventLimit(total: number, fitting: number): number {
  while (total > 1 && total > fitting) {
    total = Math.ceil(total / 2)
  }
  return Math.max(1, total)
}
