// The sends the host is handing to its child right now: their `dispatch{pending}` row is written
// before the adapter is called, so the child holds them before it can report so (`heldSends`).
// Also each send whose late settlement is being written: the child let it go before its row lands.

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** The chat's journal, which identifies the conversation for as long as it is held. */
type HandoverJournal = Pick<AgentSessionJournal, 'cursor'>

// Counted per send: a late settlement's write can open inside the same send's handover.
const handingOver = new WeakMap<HandoverJournal, Map<string, number>>()
const NONE: ReadonlyMap<string, number> = new Map()

/** The sends this journal's chat is handing over now, each with its open windows. */
export function structuredAgentSessionHandingOver(
  journal: HandoverJournal
): ReadonlyMap<string, number> {
  return handingOver.get(journal) ?? NONE
}

/** Runs one handover with its send counted as held, from before its pending row until the adapter
 *  answered; `released` then republishes what is current, which no row may follow. */
export async function whileStructuredAgentSessionHandingOver<T>(
  journal: HandoverJournal,
  clientMessageId: string,
  handOver: (released: () => void) => Promise<T>,
  workChanged?: () => void
): Promise<T> {
  const released = beginStructuredAgentSessionHandover(journal, clientMessageId, workChanged)
  try {
    return await handOver(released)
  } finally {
    released()
  }
}

/** The same held window across the host's separate pending-row and provider-call steps. */
export function beginStructuredAgentSessionHandover(
  journal: HandoverJournal,
  clientMessageId: string,
  workChanged?: () => void
): () => void {
  let sends = handingOver.get(journal)
  if (!sends) {
    sends = new Map()
    handingOver.set(journal, sends)
  }
  sends.set(clientMessageId, (sends.get(clientMessageId) ?? 0) + 1)
  let held = true
  return (): void => {
    if (held) {
      held = false
      const count = sends.get(clientMessageId) ?? 1
      if (count > 1) {
        sends.set(clientMessageId, count - 1)
      } else {
        sends.delete(clientMessageId)
      }
      workChanged?.()
    }
  }
}
