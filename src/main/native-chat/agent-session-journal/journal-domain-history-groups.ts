import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  historyContentBytes,
  oversizedHistoryItem,
  submissionBytesByItemId,
  type HistoryReader,
  type HistoryItemForm
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { JournalSqlScope } from './journal-sql-scope'
import {
  isJournalDomainSourceHeader,
  readJournalDomainSourceBody
} from './journal-domain-source-items'
import { readJournalDomainClientItems } from './journal-domain-item-presentation'
import { readJournalDomainStopStates } from './journal-domain-item-display'
import { itemSubmissions } from './journal-domain-history-after'
import type { JournalDomainHistoryHead } from './journal-domain-history-page'
import type { JournalDomainHistoryHeader } from './journal-domain-history-window'

type HistoryReaderForm = Pick<HistoryReader, 'form' | 'budgetBytes'> & {
  presentSubmission?: (send: AgentJournalSubmission) => AgentJournalSubmission
}

/** Form only positional candidates through the first exact non-fitting sequence group. */
export function formJournalDomainHistoryGroups(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  groups: readonly JournalDomainHistoryHeader[][],
  reader: HistoryReaderForm,
  forms: Map<string, HistoryItemForm>
): { groups: AgentJournalRenderItem[][]; submissions: AgentJournalSubmission[] } {
  const kept: AgentJournalRenderItem[][] = []
  const submissions: AgentJournalSubmission[] = []
  const ordinals = new Map<string, number>()
  const byItem = new Map<string, AgentJournalSubmission[]>()
  const ids = groups.flatMap((group) => group.map((header) => header.itemId))
  const states = readJournalDomainStopStates(
    db,
    head,
    groups.flatMap((group) =>
      group
        .filter((header) => header.bytes === null && !forms.has(header.itemId))
        .map((header) => header.itemId)
    )
  )
  const bodies = reader.presentSubmission
    ? undefined
    : new Map(
        readJournalDomainClientItems(db, head, ids, forms, states).map((item) => [
          item.itemId,
          item
        ])
      )
  if (bodies) {
    itemSubmissions(db, head, ids, undefined, ordinals, byItem)
  }
  let total = 0
  for (const group of groups) {
    const sends = bodies
      ? group.flatMap((header) => byItem.get(header.itemId) ?? [])
      : itemSubmissions(
          db,
          head,
          group.map((header) => header.itemId),
          reader.presentSubmission,
          ordinals
        )
    const selected =
      bodies ??
      new Map(
        readJournalDomainClientItems(
          db,
          head,
          group.map((header) => header.itemId),
          forms,
          states
        ).map((item) => [item.itemId, item])
      )
    const formed = group.map((header) =>
      reader.form(
        isJournalDomainSourceHeader(header)
          ? readJournalDomainSourceBody(new JournalSqlScope(db, head.sessionId, head.epoch), header)
          : selected.get(header.itemId)!
      )
    )
    const bytes = historyContentBytes(formed, [], submissionBytesByItemId(sends))
    if (kept.length > 0 && total + bytes > reader.budgetBytes) {
      break
    }
    kept.push(
      formed.map(({ item }) => (bytes > reader.budgetBytes ? oversizedHistoryItem(item) : item))
    )
    submissions.push(...sends)
    total += bytes
    if (bytes > reader.budgetBytes) {
      break
    }
  }
  submissions.sort(
    (a, b) =>
      a.submittedAt - b.submittedAt ||
      ordinals.get(a.clientMessageId)! - ordinals.get(b.clientMessageId)!
  )
  return { groups: kept, submissions }
}
