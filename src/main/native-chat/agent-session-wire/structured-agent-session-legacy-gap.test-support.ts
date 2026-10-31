import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { insertCommandReceiptIfAbsent } from '../agent-session-journal/command-receipt-table'
import { writeCommandReceiptTestRecord } from '../agent-session-journal/command-receipt-test-support'
import {
  insertTestJournalRow,
  writeTestLegacyTerminalGaps,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalSubmissionRow } from '../agent-session-journal/journal-row-schema'
import { hostTestMessage } from './structured-agent-session-host-test-data'

/** Actual unannotated initial-source writer shape, including terminal direct inputs between consumers. */
export function writeLegacyGapFixture(root: string, journal: AgentSessionJournal, n: number): void {
  const database = openTestJournalHostDatabase(root)
  const { sessionId } = journal['identity']
  const { epoch, sequence } = journal.cursor()
  let seq = sequence
  const base = () => ({ v: 3, epoch, seq: ++seq, fence: 1, ts: 1 })
  for (const id of ['C', 'D']) {
    const coordinate = { epoch, sequence: seq + 1 }
    insertTestJournalRow(database.db, sessionId, {
      ...base(),
      kind: 'queue',
      messageId: id,
      change: {
        op: 'queued',
        body:
          id === 'C'
            ? { ...hostTestMessage('/compact'), command: { name: 'compact' } }
            : hostTestMessage(id),
        position: id === 'C' ? 0 : 1,
        queuedAt: coordinate
      }
    })
  }
  const submission = (id: string) => {
    const row: JournalSubmissionRow = {
      ...base(),
      kind: 'submission' as const,
      clientMessageId: id,
      payloadFingerprint: id,
      body: hostTestMessage(id),
      providerHandle: agentSessionJournalProviderHandle(journal['identity']),
      handoverRecorded: true,
      origin: 'client' as const,
      options: { effort: 'high' }
    }
    insertTestJournalRow(database.db, sessionId, row)
    return row.seq
  }
  seq = writeTestLegacyTerminalGaps(
    database.db,
    sessionId,
    {
      epoch,
      sequence: seq,
      fence: 1,
      providerHandle: agentSessionJournalProviderHandle(journal['identity'])
    },
    n
  )
  const acceptedSequence = submission('legacy-M')
  database.transaction((db) => {
    writeCommandReceiptTestRecord(db, sessionId)
    insertCommandReceiptIfAbsent(
      db,
      { kind: 'global' },
      {
        operationId: 'legacy-M',
        sessionId,
        callerKey: 'fixture',
        method: 'agentSession.send',
        fingerprint: 'legacy-M',
        status: 'accepted',
        acceptedAt: 1,
        result: { kind: 'journal-row', epoch, sequence: acceptedSequence }
      }
    )
  })
}
