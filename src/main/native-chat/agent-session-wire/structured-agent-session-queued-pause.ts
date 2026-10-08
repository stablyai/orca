// Whether the queue is paused, and why — derived from the journal and the cards
// (`queued-message-pause.ts`), never stored. A Stop's event, a Resume and a reopen that found
// waiting cards are journal rows; an explicit Resume lifts any pause.

import { randomUUID } from 'node:crypto'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { DerivedQueuePause } from '../agent-session-journal/queued-message-pause'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** A per-process id, minted once per host process like the runtime's own
 *  `runtimeId` (`orca-runtime-runtime-id.ts`), stamped on the cards this process writes or hands
 *  off. No pause reads it: an older build holds every card another instance wrote. */
let hostInstance = randomUUID()

export function structuredAgentSessionHostInstance(): string {
  return hostInstance
}

/** A new stamp, as a new host process mints. Tests only; no pause reads it. */
export function rotateStructuredAgentSessionHostInstanceForTests(): string {
  hostInstance = randomUUID()
  return hostInstance
}

type PauseJournal = Pick<AgentSessionJournal, 'queuedMessages'>

/** The queue's pauses in force, derived; none when the queue sends on its own. */
export function structuredQueuePauses(journal: PauseJournal): DerivedQueuePause[] {
  return journal.queuedMessages.pauses()
}

/** The mark of a chat that stopped running with cards waiting — Orca quit or crashed, or the chat
 *  was closed — so they wait for its next turn (`queued-message-pause.ts`). Every open marks, and
 *  so does a person's close: the idle sweep never closes a chat with cards waiting, so its
 *  eviction never reopens one. `since`: where the chat stopped, for a mark written after a send
 *  that came later, which must still lift it. Bookkeeping, so a failure is reported and never
 *  thrown; the pause then starts where the mark would have gone, holding no less. */
export async function markStructuredQueueReopen(
  sessionId: string,
  journal: Pick<AgentSessionJournal, 'markQueueReopen'>,
  fence: number,
  logger: StructuredAgentSessionLogger,
  since?: number
): Promise<void> {
  try {
    await journal.markQueueReopen(fence, since)
  } catch (error) {
    logger.warn('marking a reopened queue failed', {
      scope: 'queue-reopen-mark',
      sessionId,
      error
    })
  }
}

/** Resume: a journal row that ends every pause. Returns whether the queue was paused. */
export async function resumeStructuredQueue(
  journal: Pick<AgentSessionJournal, 'queuedMessages' | 'appendQueueResume'>,
  fence: number
): Promise<boolean> {
  if (structuredQueuePauses(journal).length === 0) {
    return false
  }
  await journal.appendQueueResume(fence)
  return true
}
