import type { JournalSendAdmissionResult } from './journal-send-admission'
import type { AgentMessageSource } from '../../../shared/agent-session/journal/agent-session-message-source'
import { copyJournalCurrentWorkAuthority } from './journal-observer-read'
import type {
  JournalAutomaticAdmit,
  JournalAutomaticSelection,
  JournalAutomaticSubmissionResult
} from './journal-automatic-submission'
import { journalMailSenderKey } from './journal-writer-host-facts'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { SqlJournalAppends } from './journal-sql-appends'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { JournalOperationReceipt } from './writing/journal-row-writer'

/** The host's answers a claim asks within its lane: each sender's mail custody, and its card guard. */
export type JournalAutomaticAnswers = {
  custody?: (source: AgentMessageSource) => QueuedMessageOwed
  admission?: JournalAutomaticAdmit
}

/** The journal lane spans the live capture, finite custody answers and the writer acknowledgement. */
export async function claimJournalAutomaticSubmission(
  journal: Pick<SqlJournalAppends, 'write'>,
  input: { clientMessageId: string; fence: number },
  capture: () => JournalAutomaticSelection | Promise<JournalAutomaticSelection>,
  owed: (source: AgentMessageSource) => QueuedMessageOwed,
  receipt?: JournalOperationReceipt,
  admit?: JournalAutomaticAdmit
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
        ...(admit ? { admission: admit } : {}),
        facts: {
          automatic: {
            selectionNow: context.savedAt,
            selection,
            ...(admit ? { admitted: null } : {})
          }
        },
        ...(receipt ? { receipt } : {})
      }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automatic-submission returns its named claim outcome.
  return commit.value as JournalAutomaticSubmissionResult
}

/** Unanswered mail and an unguarded card yield without effects; the next command keeps the same
 *  lane, live capture and the answers so far, so the guard binds to the card the writer claims. */
export async function writeJournalAutomaticSubmission(
  writer: Pick<JournalSqlOwner, 'write'>,
  command: JournalWriterCommand,
  { custody: owed, admission: admit }: JournalAutomaticAnswers
) {
  for (;;) {
    const commit = await writer.write(command)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automatic-submission returns its named outcome.
    const result = commit.value as JournalAutomaticSubmissionResult | JournalSendAdmissionResult
    const automatic = command.facts?.automatic
    if (result.kind === 'needs-admission' && automatic && admit?.(result)) {
      const { messageId, fingerprint } = result
      command = {
        ...command,
        facts: {
          ...command.facts!,
          automatic: { ...automatic, admitted: { messageId, fingerprint } }
        }
      }
      continue
    }
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
