import type { AgentSessionJournal } from './journal-store'
import type { JournalWorkReader } from './journal-work-read'

export function testJournalWorkReader(
  journal: AgentSessionJournal,
  fence: number
): JournalWorkReader {
  return (operation) =>
    journal.readWork(
      () => ({
        handle: journal.observationHandle(),
        record: {
          currentFence: fence,
          ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
        },
        child: { fence },
        handingOver: [],
        continuingUnadmitted: [],
        finalizing: [],
        openedThrough: journal.openingCursor(),
        operationalRevision: 0
      }),
      operation
    )
}
