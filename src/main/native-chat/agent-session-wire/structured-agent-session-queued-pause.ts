// Whether the queue is paused, and why — derived from the journal and the cards
// (`queued-message-pause.ts`), never stored. A Stop's event and a Resume are journal
// rows; an explicit Resume lifts any pause.

import { randomUUID } from 'node:crypto'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { DerivedQueuePause } from '../agent-session-journal/queued-message-pause'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** A per-process id, minted once per host process like the runtime's own
 *  `runtimeId` (`orca-runtime-runtime-id.ts`); a draft written by another
 *  instance pauses the queue rather than auto-sending after a restart. */
let hostInstance = randomUUID()

export function structuredAgentSessionHostInstance(): string {
  return hostInstance
}

/** Simulates a host-process restart. Tests only. */
export function rotateStructuredAgentSessionHostInstanceForTests(): string {
  hostInstance = randomUUID()
  return hostInstance
}

type PauseJournal = Pick<AgentSessionJournal, 'queuedMessages'>

/** The queue's pauses in force, derived; none when the queue sends on its own. */
export function structuredQueuePauses(journal: PauseJournal): DerivedQueuePause[] {
  return journal.queuedMessages.pauses(hostInstance)
}

/**
 * Every journal publish: a restart's rows are adopted into this instance once a person's turn
 * started. The derivation already reads them as lifted; the write keeps that answer when the
 * handle reopens (its "since this conversation opened" moves). Bookkeeping: a failure is reported.
 */
export async function adoptEndedRestartPause(
  sessionId: string,
  journal: PauseJournal,
  logger: StructuredAgentSessionLogger
): Promise<void> {
  try {
    const { queuedMessages } = journal
    const restarted = queuedMessages
      .list()
      .some((row) => row.state === 'waiting' && row.hostInstance !== hostInstance)
    if (restarted && queuedMessages.restartEnded()) {
      await queuedMessages.adopt(hostInstance)
    }
  } catch (error) {
    logger.warn("adopting a restart's queued cards after a started turn failed", {
      scope: 'queue-pause-adoption',
      sessionId,
      error
    })
  }
}

/** Resume: a journal row that ends a Stop's or a /clear's pause, and adoption of a restart's
 *  rows. Returns whether the queue was paused. */
export async function resumeStructuredQueue(
  journal: Pick<AgentSessionJournal, 'queuedMessages' | 'appendQueueResume'>,
  fence: number
): Promise<boolean> {
  if (structuredQueuePauses(journal).length === 0) {
    return false
  }
  await journal.appendQueueResume(fence)
  await journal.queuedMessages.adopt(hostInstance)
  return true
}
