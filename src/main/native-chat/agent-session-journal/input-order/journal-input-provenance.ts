import type Database from '../../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { readCommandReceipt } from '../writing/command-receipt-table'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'

/** A queue drain inherits its enqueue caller; explicit Send owns its own receipt. */
export function journalInputCaller(
  db: Database.Database,
  sessionId: string,
  submission: AgentJournalSubmission
): string | undefined {
  for (const id of [submission.clientMessageId, submission.queuedMessageId]) {
    if (!id) {
      continue
    }
    const read = readCommandReceipt(db, { kind: 'global' }, id)
    if (
      read.verdict === 'readable' &&
      read.receipt.status === 'accepted' &&
      read.receipt.sessionId === sessionId &&
      (read.receipt.method === 'agentSession.create' ||
        read.receipt.method === 'agentSession.send' ||
        read.receipt.method === 'agentSession.queuedMessageSend')
    ) {
      return read.receipt.callerKey
    }
  }
  return undefined
}

/** Only the original send's accepted coordinate can compare a retired enqueue boundary. */
export function journalInputAcceptance(
  db: Database.Database,
  sessionId: string,
  id: string
): AgentJournalCursor | undefined {
  const read = readCommandReceipt(db, { kind: 'global' }, id)
  if (
    read.verdict === 'readable' &&
    read.receipt.status === 'accepted' &&
    read.receipt.sessionId === sessionId &&
    read.receipt.method === 'agentSession.send' &&
    read.receipt.result.kind === 'journal-row'
  ) {
    return { epoch: read.receipt.result.epoch, sequence: read.receipt.result.sequence }
  }
  return undefined
}
