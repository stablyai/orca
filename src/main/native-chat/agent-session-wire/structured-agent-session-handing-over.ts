// The sends the host is handing to its child right now: their `dispatch{pending}` row is written
// before the adapter is called, so the child holds them before it can report so (`heldSends`).

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** The chat's journal, which identifies the conversation for as long as it is held. */
type HandoverJournal = Pick<AgentSessionJournal, 'cursor'>

const handingOver = new WeakMap<HandoverJournal, Set<string>>()
const NONE: ReadonlySet<string> = new Set()

/** The sends this journal's chat is handing over now. */
export function structuredAgentSessionHandingOver(journal: HandoverJournal): ReadonlySet<string> {
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
  let sends = handingOver.get(journal)
  if (!sends) {
    sends = new Set()
    handingOver.set(journal, sends)
  }
  sends.add(clientMessageId)
  let held = true
  const released = (): void => {
    if (held) {
      held = false
      sends.delete(clientMessageId)
      workChanged?.()
    }
  }
  try {
    return await handOver(released)
  } finally {
    released()
  }
}
