// Count pending handovers and late-settlement writes as held until child/journal state catches up.

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

type HandoverJournal = Pick<AgentSessionJournal, 'cursor'>

// Late settlement can overlap its own send’s handover; retain nested counts.
const handingOver = new WeakMap<HandoverJournal, Map<string, number>>()
const NONE: ReadonlyMap<string, number> = new Map()

export function structuredAgentSessionHandingOver(
  journal: HandoverJournal
): ReadonlyMap<string, number> {
  return handingOver.get(journal) ?? NONE
}

/** Hold from before pending-row write through adapter reply; republish on release even without later rows. */
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

/** Span separate pending-row/provider-call steps with the same held window. */
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
