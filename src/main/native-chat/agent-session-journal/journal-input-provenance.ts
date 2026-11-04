import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { readCommandReceipt, type CommandReceiptRead } from './command-receipt-table'
import type { JournalReadConnection } from './journal-sql-owner'

/** Only the original send's accepted coordinate can compare a retired enqueue boundary. */
export function journalInputAcceptance(
  db: Database.Database,
  sessionId: string,
  id: string
): AgentJournalCursor | undefined {
  return journalReceiptAcceptance(readCommandReceipt(db, { kind: 'global' }, id), sessionId)
}

function journalReceiptAcceptance(
  read: CommandReceiptRead,
  sessionId: string
): AgentJournalCursor | undefined {
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
/** A missing prepared fact is an integration error, never evidence of an absent receipt. */
export async function prepareJournalAcceptance(
  read: Pick<JournalReadConnection, 'receipts'>,
  sessionId: string,
  ids: readonly string[]
): Promise<(id: string) => AgentJournalCursor | undefined> {
  const receipts = await read.receipts({ kind: 'global' }, [...new Set(ids)])
  return (id) => {
    const receipt = receipts.get(id)
    if (!receipt) {
      throw new Error('Journal input acceptance was not prepared')
    }
    return journalReceiptAcceptance(receipt, sessionId)
  }
}
