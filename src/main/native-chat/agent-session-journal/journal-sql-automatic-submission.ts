import type { JournalSendAdmissionResult } from './journal-send-admission'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { copyJournalCurrentWorkAuthority } from './journal-observer-read'
import type {
  JournalAutomaticSelection,
  JournalAutomaticSubmissionResult
} from './journal-automatic-submission'
import { journalMailSenderKey } from './journal-writer-host-facts'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { SqlJournalAppends } from './journal-sql-appends'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { JournalOperationReceipt } from './writing/journal-row-writer'

/** The journal lane spans the live capture, finite custody answers and the writer acknowledgement. */
export async function claimJournalAutomaticSubmission(
  journal: Pick<SqlJournalAppends, 'write'>,
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
      return {
        custody: owed,
        facts: {
          automatic: {
            selectionNow: context.savedAt,
            selection
          }
        },
        ...(receipt ? { receipt } : {})
      }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automatic-submission returns its named claim outcome.
  return commit.value as JournalAutomaticSubmissionResult
}

/** Unanswered mail yields without effects; the next command keeps the same lane and live capture. */
export async function writeJournalAutomaticSubmission(
  writer: Pick<JournalSqlOwner, 'write'>,
  command: JournalWriterCommand,
  owed: ((source: AgentMessageSource) => QueuedMessageOwed) | undefined
) {
  for (;;) {
    const commit = await writer.write(command)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automatic-submission returns its named outcome.
    const result = commit.value as JournalAutomaticSubmissionResult | JournalSendAdmissionResult
    if (result.kind !== 'needs-custody') {
      return commit
    }
    command = {
      ...command,
      facts: {
        ...command.facts!,
        mail: [
          ...(command.facts?.mail ?? []),
          [journalMailSenderKey(result.source), owed?.(result.source) ?? 'unavailable']
        ]
      }
    }
  }
}
