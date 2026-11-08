import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { copyJournalCurrentWorkAuthority } from './journal-observer-read'
import type {
  JournalAutomaticSelection,
  JournalAutomaticSubmissionResult
} from './journal-automatic-submission'
import type { SqlJournalAppends } from './journal-sql-appends'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { JournalOperationReceipt } from './writing/journal-row-writer'

/** The journal lane spans the ready read, one custody decision and the writer acknowledgement. */
export async function claimJournalAutomaticSubmission(
  journal: Pick<SqlJournalAppends, 'write' | 'reads' | 'reopenFloor'>,
  input: { clientMessageId: string; fence: number },
  capture: () => JournalAutomaticSelection | Promise<JournalAutomaticSelection>,
  owed: (source: AgentMessageSource) => QueuedMessageOwed,
  receipt?: JournalOperationReceipt
): Promise<JournalAutomaticSubmissionResult> {
  const commit = await journal.write(
    { kind: 'automatic-submission', ...input },
    async (context) => {
      const captured = await capture()
      const selection = {
        ...structuredClone(captured),
        authority: copyJournalCurrentWorkAuthority(captured.authority)
      }
      const result = await journal.reads.queue({
        kind: 'automatic-preparation',
        selection,
        now: context.savedAt,
        facts: { reopenFloor: journal.reopenFloor() }
      })
      if (result.kind !== 'automatic-preparation') {
        throw new Error('journal automatic preparation returned a different answer')
      }
      const preparation = result.preparation
      return {
        facts: {
          automatic: {
            selectionNow: context.savedAt,
            selection,
            preparation,
            owed: preparation.mail ? owed(preparation.mail.source) : 'owed'
          }
        },
        ...(receipt ? { receipt } : {})
      }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automatic-submission returns its named claim outcome.
  return commit.value as JournalAutomaticSubmissionResult
}
