import type { MessageRow } from '../../../../orchestration/types'

// Why: read/sequence and the pointer_* and sender_pane_key columns are delivery plumbing
// the runtime owns. Publishing them made a caller treat internal state as mailbox truth.
const INTERNAL_MESSAGE_COLUMNS = [
  'read',
  'sequence',
  'sender_pane_key',
  'pointer_enter_pending',
  'pointer_pty_id',
  'pointer_process_incarnation'
] as const

export type MailboxMessageReceipt = Omit<MessageRow, (typeof INTERNAL_MESSAGE_COLUMNS)[number]>

export function exposeMessage(message: MessageRow): MailboxMessageReceipt {
  return exposeMessages([message])[0]!
}

export function exposeMessages(messages: MessageRow[]): MailboxMessageReceipt[] {
  return messages.map((message) => {
    const exposed: Partial<MessageRow> = { ...message }
    for (const column of INTERNAL_MESSAGE_COLUMNS) {
      delete exposed[column]
    }
    return exposed as MailboxMessageReceipt
  })
}
