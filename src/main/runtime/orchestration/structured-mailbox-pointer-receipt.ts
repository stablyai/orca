import type { OrchestrationDb, MessageRow } from './db'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'

export function recordStructuredMailHandoff(
  db: OrchestrationDb,
  mailbox: string,
  messages: readonly MessageRow[],
  update: (member: StructuredMailHandoff) => StructuredMailHandoff
): void {
  for (const message of messages) {
    const member = readMailHandoff(message.handoff)
    if (member?.kind === 'structured') {
      db.recordMailHandoff(mailbox, [message], update(member))
    }
  }
}

export function reconcileStructuredMailInput(
  host: StructuredMailboxPointerHost,
  db: OrchestrationDb,
  mailbox: string,
  messages: readonly MessageRow[],
  reference: StructuredMailHandoff
): boolean {
  try {
    const receipt = host.readReceipt?.(reference)
    if (receipt?.verdict === 'readable' && receipt.receipt.status === 'accepted') {
      const result = receipt.receipt.result
      recordStructuredMailHandoff(db, mailbox, messages, (member) => ({
        ...member,
        phase: 'offered',
        clientMessageId: result.kind === 'queued-draft' ? result.messageId : member.clientMessageId
      }))
      return false
    }
    return receipt?.verdict !== 'unreadable'
  } catch {
    return false
  }
}
