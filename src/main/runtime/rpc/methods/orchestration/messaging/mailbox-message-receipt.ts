import type { OrchestrationDb } from '../../../../orchestration/db'
import { formatMessageBanner } from '../../../../orchestration/formatter'
import { withAgentVisibleAddresses } from '../../../../orchestration/structured-session-mail-address'
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

/**
 * Rows as the reader of a mailbox sees them. Only reads are re-spelled: a send receipt echoes its
 * stored row, whose sender key worker_done settlement matches.
 */
export function exposeReadMessages(
  messages: readonly MessageRow[],
  db: OrchestrationDb
): MailboxMessageReceipt[] {
  return exposeMessages(withAgentVisibleAddresses(messages, db))
}

export function formatReadMessages(
  messages: readonly MessageRow[] | undefined,
  db: OrchestrationDb
): string {
  return withAgentVisibleAddresses(messages ?? [], db)
    .map((message) => formatMessageBanner(message))
    .join('\n\n')
}
