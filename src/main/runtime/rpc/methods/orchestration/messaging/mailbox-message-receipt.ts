import type { MessageRow } from '../../../../orchestration/types'

// Hide read/sequence, pointer_* and sender_pane_key: they are runtime delivery plumbing, not caller mailbox truth.
const INTERNAL_MESSAGE_COLUMNS = [
  'read',
  'sequence',
  'ordering_origin',
  'sender_pane_key',
  'pointer_enter_pending',
  'pointer_pty_id',
  'pointer_process_incarnation',
  'handoff',
  'recovery_used'
] as const

export type MailboxMessageReceipt = Omit<MessageRow, (typeof INTERNAL_MESSAGE_COLUMNS)[number]>

export function exposeMessage(message: MessageRow): MailboxMessageReceipt {
  return exposeMessages([message])[0]!
}

export function exposeMessages(messages: MessageRow[]): MailboxMessageReceipt[] {
  return messages.map((message) => {
    const exposed: Partial<MessageRow> = { ...message }
    for (const column of INTERNAL_MESSAGE_COLUMNS) {
      Reflect.deleteProperty(exposed, column)
    }
    return exposed as MailboxMessageReceipt
  })
}
