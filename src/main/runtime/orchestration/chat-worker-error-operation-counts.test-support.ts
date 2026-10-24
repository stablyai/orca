import { vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import * as stopProjection from '../../native-chat/agent-session-journal/journal-stop-note-projection'
import * as lineage from './structured-session-lineage'
import * as journalPosition from '../../../shared/agent-session-journal-position'
import * as liveTurn from '../../../shared/structured-agent-session-live-turn'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../agent-session-record-store-test-harness'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'

// Per-instance array reads count the actual find/iteration work without replacing the algorithms.
function countedEntries<T>(entries: T[], visit: () => void): T[] {
  entries.forEach((entry, index) => {
    Object.defineProperty(entries, index, {
      get: () => {
        visit()
        return entry
      }
    })
  })
  return entries
}

const emptyCounts = () => ({
  baselineItems: 0,
  runningTurnScans: 0,
  runningTurnItems: 0,
  itemLookups: 0,
  bodyLookups: 0,
  submissionsCopied: 0,
  submissionVisits: 0,
  lineageCopied: 0,
  lineageVisits: 0,
  snapshots: 0,
  projectedItems: 0,
  orderingComparisons: 0,
  materializedItems: 0,
  materializedSubmissions: 0,
  wordItemReads: 0,
  wordSubmissionReads: 0
})

export async function countChatFailureOperations(
  journal: AgentSessionJournal,
  stateDirectory: string,
  population: number
) {
  await seedTestAgentSessionRecordStore(stateDirectory, {
    records: Array.from({ length: population }, () =>
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: randomUUID() }))
    )
  })
  const store = await openTestAgentSessionRecordStore(stateDirectory)
  const counts = emptyCounts()
  const runningTurns: (string | null)[] = []
  const runningTurn = liveTurn.runningStructuredAgentSessionTurnItemBySequence
  vi.spyOn(liveTurn, 'runningStructuredAgentSessionTurnItemBySequence').mockImplementation(
    (items) => {
      counts.runningTurnScans++
      const result = runningTurn({
        *[Symbol.iterator]() {
          for (const item of items) {
            counts.runningTurnItems++
            yield item
          }
        }
      })
      runningTurns.push(result?.turnId ?? null)
      return result
    }
  )
  const list = store.listRecords.bind(store)
  vi.spyOn(store, 'listRecords').mockImplementation(() => {
    const records = list()
    counts.lineageCopied += records.length
    return records.map((record) => ({
      ...record,
      get conversationCommand() {
        counts.lineageVisits++
        return record.conversationCommand
      }
    }))
  })
  vi.spyOn(lineage, 'readAgentSessionRecordStore').mockReturnValue(store)
  const visit = journal.visitItems.bind(journal)
  vi.spyOn(journal, 'visitItems').mockImplementation((callback) =>
    visit((...args) => {
      counts.baselineItems++
      callback(...args)
    })
  )
  const item = journal.item.bind(journal)
  vi.spyOn(journal, 'item').mockImplementation((...args) => {
    counts.itemLookups++
    return item(...args)
  })
  const body = journal.itemBody.bind(journal)
  vi.spyOn(journal, 'itemBody').mockImplementation((...args) => {
    counts.bodyLookups++
    return body(...args)
  })
  const submissions = journal.submissions.bind(journal)
  vi.spyOn(journal, 'submissions').mockImplementation(() => {
    const entries = submissions()
    counts.submissionsCopied += entries.length
    return countedEntries(entries, () => counts.submissionVisits++)
  })
  const project = stopProjection.projectJournalStopNote
  vi.spyOn(stopProjection, 'projectJournalStopNote').mockImplementation((...args) => {
    counts.projectedItems++
    return project(...args)
  })
  const compare = journalPosition.compareAgentJournalItems
  vi.spyOn(journalPosition, 'compareAgentJournalItems').mockImplementation((...args) => {
    counts.orderingComparisons++
    return compare(...args)
  })
  const snapshot = journal.snapshot.bind(journal)
  vi.spyOn(journal, 'snapshot').mockImplementation(() => {
    const result = snapshot()
    counts.snapshots++
    counts.materializedItems += result.items.length
    counts.materializedSubmissions += result.submissions.length
    return {
      ...result,
      items: countedEntries(result.items, () => counts.wordItemReads++),
      submissions: countedEntries(result.submissions, () => counts.wordSubmissionReads++)
    }
  })
  return {
    counts,
    runningTurns,
    reset: () => {
      Object.assign(counts, emptyCounts())
      runningTurns.length = 0
    }
  }
}
