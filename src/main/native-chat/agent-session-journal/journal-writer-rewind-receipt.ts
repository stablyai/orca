import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { readJournalUsageLimitContinueIdentity } from './journal-status-cuts'
import { JournalHostFactsNeededError, type JournalRewoundFacts } from './journal-writer-host-facts'
import type { JournalOperationReceipt } from './writing/journal-row-writer'

/** The host stages a completion from the cursor and usage cut a rewind leaves; the writer
 *  proves both inside the command, or rolls back asking for them. */
export function journalRewoundReceipt(
  known: JournalRewoundFacts | undefined,
  receipt: JournalOperationReceipt
): (cursor: AgentJournalCursor) => JournalOperationReceipt {
  return (cursor) => ({
    fold: (draft) => {
      const cancel = readJournalUsageLimitContinueIdentity(draft) ?? null
      if (
        known?.cursor.epoch !== cursor.epoch ||
        known.cursor.sequence !== cursor.sequence ||
        known.cancel?.turnItemId !== cancel?.turnItemId ||
        known.cancel?.resetsAt !== cancel?.resetsAt
      ) {
        throw new JournalHostFactsNeededError({ rewound: { cursor, cancel } })
      }
    },
    write: receipt.write,
    committed: receipt.committed
  })
}
