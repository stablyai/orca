/** Why mail to a worker is not delivered right now, read from the same gates that hold it, so a send
 *  receipt says only what is true at send time. Null means delivery would go ahead. */

export type MailboxDeliveryHold =
  | { kind: 'not-foreground'; agentName: string }
  | { kind: 'not-live'; agentName: string }
  /** A terminal dialog only a person can answer. */
  | { kind: 'prompt' }
  /** Typed text in the worker's terminal that delivery would submit with the mail. */
  | { kind: 'draft' }
  /** The worker's terminal is still restoring after a restart, so a draft cannot be ruled out yet. */
  | { kind: 'restoring' }
  /** The worker's own status says it is blocked (for example on a permission it asked for). */
  | { kind: 'blocked'; reason: string }
  /** A program Orca does not recognize is running; typed mail would reach it as input. */
  | { kind: 'busy-program' }
  /** Something on the worker's screen refuses typed input (a menu, a picker, a dialog). */
  | { kind: 'overlay' }
  /** The worker has not settled at its prompt (a permission request, a question, or output still arriving). */
  | { kind: 'unsettled' }
  /** The chat accepts the mail into its queue behind an open prompt or question. */
  | { kind: 'behind-prompt' }
  /** The chat is detached from its agent, or not attached here; the mail waits for it. */
  | { kind: 'detached' }
  /** The chat refuses new messages for now. */
  | { kind: 'refused'; reason: string }

/** What a chat's mail admission would do with a message now; null when the chat cannot be read. */
export type ChatMailAdmitFacts =
  | { attached: false }
  | { attached: true; fenced: boolean; refusal: string | null; behindPrompt: boolean }

export type MailboxDeliveryHoldReaders = {
  /** The chat a mailbox's mail reaches, if a chat holds it. */
  chatSessionFor: (mailbox: string) => string | null
  readChatAdmit: (sessionId: string) => Promise<ChatMailAdmitFacts | null>
  /** The terminal handle a mailbox's pointer is typed into, if a terminal holds it. */
  terminalFor: (mailbox: string) => string | null
  readTerminalHold: (
    terminalHandle: string
  ) => MailboxDeliveryHold | null | Promise<MailboxDeliveryHold | null>
}

/** The chat pointer's own admission order: no fence or no attachment parks, a refusal parks, and an
 *  open prompt queues the mail where the agent sees it only once the prompt is answered. */
export function chatMailHold(facts: ChatMailAdmitFacts): MailboxDeliveryHold | null {
  if (!facts.attached || !facts.fenced) {
    return { kind: 'detached' }
  }
  if (facts.refusal) {
    return { kind: 'refused', reason: facts.refusal }
  }
  return facts.behindPrompt ? { kind: 'behind-prompt' } : null
}

export async function readMailboxDeliveryHold(
  mailbox: string,
  readers: MailboxDeliveryHoldReaders
): Promise<MailboxDeliveryHold | null> {
  const sessionId = readers.chatSessionFor(mailbox)
  if (sessionId) {
    // An unreadable chat proves nothing either way.
    const facts = await readers.readChatAdmit(sessionId)
    return facts ? chatMailHold(facts) : null
  }
  const terminal = readers.terminalFor(mailbox)
  return terminal ? readers.readTerminalHold(terminal) : null
}

export function describeMailboxDeliveryHold(recipient: string, hold: MailboxDeliveryHold): string {
  switch (hold.kind) {
    case 'not-foreground':
      return `Queued. ${hold.agentName} isn't in the foreground of that terminal; the message will be delivered when it's back.`
    case 'not-live':
      return `Queued. The message will arrive once ${hold.agentName} is back.`
    case 'prompt':
      return `Queued. ${recipient} is at a prompt that needs a person; delivery is held while it stays open.`
    case 'draft':
      return `Queued. ${recipient}'s terminal has typed text that is not sent yet; delivery is held until it is sent or cleared.`
    case 'restoring':
      return `Queued. ${recipient}'s terminal is still restoring; delivery waits until Orca can read it.`
    case 'blocked':
      return `Queued. ${recipient} is blocked (${hold.reason}); delivery is held until that clears.`
    case 'busy-program':
      return `Queued. ${recipient}'s terminal is running a program Orca does not type into; delivery waits until the agent is back at its prompt.`
    case 'overlay':
      return `Queued. ${recipient}'s screen shows something that refuses typed input; delivery waits until it closes.`
    case 'unsettled':
      return `Queued. ${recipient} has not settled at its prompt (an open request or question, or output still arriving); delivery waits until it does.`
    case 'behind-prompt':
      return `Queued behind an open prompt; ${recipient} sees it after the prompt is answered.`
    case 'detached':
      return `Queued. ${recipient}'s chat is not attached to its agent; delivery waits until it is.`
    case 'refused':
      return `Queued. ${recipient}'s chat refuses new messages for now (${hold.reason}); delivery is retried when that changes.`
  }
}
