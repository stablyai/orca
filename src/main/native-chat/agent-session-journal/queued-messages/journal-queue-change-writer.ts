import type { JournalWriteAdmission } from '../writing/journal-write-queue'
import type { JournalOperationReceipt, JournalRowWriter } from '../writing/journal-row-writer'
import type { JournalQueueCardChange } from './journal-queue-events'
import type { JournalQueuePlan } from './journal-queued-messages'

/** Plan and accept card changes on the journal lane, then publish before releasing it. */
export function writeJournalQueueChanges<T>(
  writer: JournalRowWriter,
  planChanges: (changes: readonly JournalQueueCardChange[]) => JournalQueuePlan,
  plan: () => { changes: readonly JournalQueueCardChange[]; result: T },
  receipt?: JournalOperationReceipt,
  admission?: JournalWriteAdmission
): Promise<T> {
  let planned: { result: T; plan: JournalQueuePlan } | undefined
  return writer
    .enqueueRows(
      () => {
        const next = plan()
        planned = { result: next.result, plan: planChanges(next.changes) }
        return planned.plan.rows
      },
      {
        write: (db, row) => {
          planned?.plan.receipt.write(db, row)
          receipt?.write(db, row)
        },
        committed: () => {
          planned?.plan.receipt.committed()
          receipt?.committed()
        }
      },
      undefined,
      admission
    )
    .then(() => {
      if (!planned) {
        throw new Error('agent_session_queue_write_unplanned')
      }
      return planned.result
    })
}
