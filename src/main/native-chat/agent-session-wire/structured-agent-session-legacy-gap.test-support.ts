import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  writeCommandReceiptTestRecord,
  writeTestCommandReceipt
} from '../agent-session-journal/command-receipt-test-support'
import {
  insertTestJournalRow,
  writeTestLegacyTerminalGaps,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalSubmissionRow } from '../agent-session-journal/journal-row-schema'
import { hostTestMessage } from './structured-agent-session-host-test-data'

/** Actual unannotated initial-source writer shape, including terminal direct inputs between consumers. */
export async function writeLegacyGapFixture(
  root: string,
  journal: AgentSessionJournal,
  n: number
): Promise<void> {
  const database = await openTestJournalHostDatabase(root)
  const { sessionId } = journal['identity']
  const { epoch, sequence } = journal.cursor()
  await database.transaction((plan) => {
    let seq = sequence
    const base = () => ({ v: 3, epoch, seq: ++seq, fence: 1, ts: 1 })
    for (const id of ['C', 'D']) {
      const coordinate = { epoch, sequence: seq + 1 }
      insertTestJournalRow(plan, sessionId, {
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
      insertTestJournalRow(plan, sessionId, row)
      return row.seq
    }
    seq = writeTestLegacyTerminalGaps(
      plan,
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
    writeCommandReceiptTestRecord(plan, sessionId)
    writeTestCommandReceipt(
      plan,
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
