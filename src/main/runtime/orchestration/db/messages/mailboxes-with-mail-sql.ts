type MailboxPrefix = 'run:' | 'dispatch:'

// The next character after ':' bounds a prefix range on the to_handle index.
const prefixEnd = (prefix: MailboxPrefix) => `${prefix.slice(0, -1)};`

/**
 * The distinct `to_handle`s under one mailbox prefix with unread, undelivered mail, read from the
 * mail side through the partial index on exactly that mail, so its cost follows mail awaiting
 * delivery and never an owner's retained history. `reserved` adds mail a pointer reservation holds.
 */
export function mailboxesWithMailSql(prefix: MailboxPrefix, reserved: boolean): string {
  const range = `to_handle >= '${prefix}' AND to_handle < '${prefixEnd(prefix)}'`
  const undelivered = `SELECT to_handle FROM messages INDEXED BY idx_messages_mail_wake_candidate
    WHERE ${range} AND read = 0 AND delivered_at IS NULL AND pointer_enter_pending = 0
      AND delivery_contract = 'current_delivery'`
  if (!reserved) {
    return `${undelivered} GROUP BY to_handle`
  }
  return `${undelivered}
    UNION
    SELECT to_handle FROM messages INDEXED BY idx_messages_pending_pointer_enter
    WHERE ${range} AND read = 0 AND pointer_enter_pending > 0
      AND delivery_contract = 'current_delivery'`
}

/** The owner id a prefixed mailbox names, for a primary-key join from `mailboxesWithMailSql`. */
export function mailboxOwnerIdSql(prefix: MailboxPrefix): string {
  return `substr(mail.to_handle, ${prefix.length + 1})`
}
