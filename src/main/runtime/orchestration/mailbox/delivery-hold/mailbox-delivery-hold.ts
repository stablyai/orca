/** Why mail to a worker is held right now, read from the same gates that hold it, so a send receipt
 *  says only what is true at send time. Null means delivery would go ahead (or only waits out output). */
import type { StructuredSessionGateFacts } from '../structured-pointer/structured-session-pointer-delivery'

export type MailboxDeliveryHold =
  /** An open prompt only a person can answer: a terminal dialog, or a chat's pending approval or question. */
  | { kind: 'prompt' }
  /** The worker's own status says it is blocked (for example on a permission it asked for). */
  | { kind: 'blocked'; reason: string }
  /** Typed text in the worker's terminal that delivery would submit with the mail. */
  | { kind: 'draft' }

export type MailboxDeliveryHoldReaders = {
  /** The chat a mailbox's mail reaches, if a chat holds it. */
  chatSessionFor: (mailbox: string) => string | null
  readChatFacts: (sessionId: string) => Promise<StructuredSessionGateFacts | null>
  /** The terminal handle a mailbox's pointer is typed into, if a terminal holds it. */
  terminalFor: (mailbox: string) => string | null
  readTerminalHold: (terminalHandle: string) => MailboxDeliveryHold | null
}

export async function readMailboxDeliveryHold(
  mailbox: string,
  readers: MailboxDeliveryHoldReaders
): Promise<MailboxDeliveryHold | null> {
  const sessionId = readers.chatSessionFor(mailbox)
  if (sessionId) {
    // A chat queues mail behind its open prompt; an unreadable chat proves nothing either way.
    const facts = await readers.readChatFacts(sessionId)
    return facts?.awaitingHuman ? { kind: 'prompt' } : null
  }
  const terminal = readers.terminalFor(mailbox)
  return terminal ? readers.readTerminalHold(terminal) : null
}

export function describeMailboxDeliveryHold(recipient: string, hold: MailboxDeliveryHold): string {
  switch (hold.kind) {
    case 'prompt':
      return `Queued. ${recipient} is at a prompt that needs a person; delivery is held while it stays open.`
    case 'blocked':
      return `Queued. ${recipient} is blocked (${hold.reason}); delivery is held until that clears.`
    case 'draft':
      return `Queued. ${recipient}'s terminal has typed text that is not sent yet; delivery is held until it is sent or cleared.`
  }
}
