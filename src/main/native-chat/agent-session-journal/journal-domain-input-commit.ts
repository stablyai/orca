import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalWriterSettled } from './journal-sql-failure'
import type {
  JournalDomainSubmissionCommit,
  JournalDomainSubmissionCoordinate
} from './journal-domain-submission-records'

export type JournalDomainInputCoordinate =
  | JournalDomainSubmissionCoordinate
  | {
      kind: 'queue' | 'item' | 'command-settle'
      cursor: AgentJournalCursor
      fence: number
      observedAt: number
    }

/** Only successful savepoints contribute payloads and receipt coordinates to publication. */
export type JournalDomainInputCommit<Value> = Omit<
  JournalDomainSubmissionCommit<JournalWriterSettled<Value>>,
  'coordinates'
> & { coordinates: JournalDomainInputCoordinate[] }

export function journalDomainInputCommit<Value>(
  cursor: AgentJournalCursor,
  value: Value
): JournalDomainInputCommit<Value> {
  return {
    cursor,
    value: { value },
    coordinates: [],
    items: [],
    removedItemIds: [],
    receipts: [],
    cards: [],
    inputChanged: false
  }
}

export function appendJournalDomainInputCommit<Value>(
  result: JournalDomainInputCommit<Value>,
  commit: Omit<JournalDomainInputCommit<unknown>, 'value'>
): void {
  result.cursor = commit.cursor
  result.coordinates.push(...commit.coordinates)
  result.items.push(...commit.items)
  result.insertedItemIds ??= []
  result.insertedItemIds.push(...(commit.insertedItemIds ?? []))
  result.removedItemIds.push(...commit.removedItemIds)
  result.receipts.push(...commit.receipts)
  result.cards.push(...commit.cards)
  result.inputChanged ||= commit.inputChanged
  if (commit.promptDispatches?.length) {
    result.promptDispatches ??= []
    result.promptDispatches.push(...commit.promptDispatches)
  }
  result.acceptedInputs = commit.acceptedInputs ?? result.acceptedInputs
  if (commit.editDeadline !== undefined) {
    result.editDeadline = commit.editDeadline
  }
  if (commit.referencedUploads?.length) {
    result.referencedUploads = [...(result.referencedUploads ?? []), ...commit.referencedUploads]
  }
}
