/**
 * Which message is a chat assignee's owed dispatch preamble. Only the host writes one, under an id
 * derived from its Dispatch that no sender can choose, so no `--type` or body can forge it. Every
 * mail reader hides it and only the structured lane sends it, as the chat's turn: a chat never
 * reads its preamble as mail, as a terminal never does.
 */

const PREAMBLE_ID_PREFIX = 'dpreamble_'
const DISPATCH_MAILBOX_PREFIX = 'dispatch:'

export function dispatchPreambleMessageId(dispatchId: string): string {
  return `${PREAMBLE_ID_PREFIX}${dispatchId}`
}

export function isOwedDispatchPreamble(mailboxHandle: string, message: { id: string }): boolean {
  return (
    mailboxHandle.startsWith(DISPATCH_MAILBOX_PREFIX) &&
    message.id === dispatchPreambleMessageId(mailboxHandle.slice(DISPATCH_MAILBOX_PREFIX.length))
  )
}

/** The same rule over a `messages` row, for every SQL reader of mail. */
export const NOT_OWED_DISPATCH_PREAMBLE_SQL = `NOT (messages.to_handle LIKE '${DISPATCH_MAILBOX_PREFIX}%' AND messages.id = '${PREAMBLE_ID_PREFIX}' || substr(messages.to_handle, ${DISPATCH_MAILBOX_PREFIX.length + 1}))`
