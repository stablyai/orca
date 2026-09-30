// Whether the queue is paused, and why — DERIVED, never stored as a flag. The
// queue is paused when:
//   - 'stopped': the user's last Stop took effect (its recorded journal
//     position) and no turn a person asked for has started since — or
//     'cleared', the same for a /clear's replacement, whose carried cards
//     start paused; or
//   - 'restarted': a waiting draft was written by another host process and no
//     turn a person asked for has started since this conversation opened.
// A person's turn is a submission whose recorded origin is `client` (a send over
// the client send RPC, or a card they sent now) that the provider accepted.
// Orchestration mail, a restart continuation, a host-sent launch prompt and the
// queue's own drain are `host` and never lift it. An explicit Resume lifts any.

import { randomUUID } from 'node:crypto'
import type { AgentSessionQueuePause } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuePauseFact } from '../agent-session-journal/queued-message-pause-table'

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

type PauseJournal = Pick<AgentSessionJournal, 'queuedMessages' | 'cursor' | 'wroteBeforeOpen'>

// Both read the reducer's latest accepted person turn (its submission row), so a
// derivation on every publish costs no scan of the submissions.

function stopEnded(journal: PauseJournal, stop: QueuePauseFact): boolean {
  const latest = journal.queuedMessages.latestPersonTurnSequence()
  // Sent after the Stop: a send made before it no longer lifts it, even if its turn starts later.
  return stop.epoch !== journal.cursor().epoch ? latest > 0 : latest > stop.sequence
}

function restartPending(journal: PauseJournal): boolean {
  return journal.queuedMessages
    .list()
    .some((row) => row.state === 'waiting' && row.hostInstance !== hostInstance)
}

function restartEnded(journal: PauseJournal): boolean {
  const latest = journal.queuedMessages.latestPersonTurnSequence()
  return latest > 0 && !journal.wroteBeforeOpen(latest)
}

/** The queue's pause, derived; null when the queue sends on its own. */
export function structuredQueuePause(journal: PauseJournal): AgentSessionQueuePause | null {
  const stop = journal.queuedMessages.pause()
  if (stop && !stopEnded(journal, stop)) {
    return { reason: stop.reason }
  }
  if (restartPending(journal) && !restartEnded(journal)) {
    return { reason: 'restarted' }
  }
  return null
}

/**
 * Every journal publish: retire what a person's started turn already ended — the
 * Stop fact it superseded, and a restart's rows, adopted into this instance. The
 * derivation already reads them as lifted; the write keeps that answer when the
 * handle reopens (the restart's "since this conversation opened" moves) and spares
 * later derivations the submission scan. Bookkeeping: a failure is reported.
 */
export async function retireEndedQueuePause(
  sessionId: string,
  journal: PauseJournal
): Promise<void> {
  try {
    const stop = journal.queuedMessages.pause()
    const retireStop = stop !== null && stopEnded(journal, stop) ? stop : null
    const adopt = restartPending(journal) && restartEnded(journal)
    if (retireStop === null && !adopt) {
      return
    }
    await journal.queuedMessages.liftPause({
      stop: retireStop,
      adoptInto: adopt ? hostInstance : null
    })
  } catch (error) {
    console.warn("[agent-session] a started turn's queue-pause retirement skipped:", {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** Resume: ends whichever pause holds the queue. Returns whether it was paused. */
export async function resumeStructuredQueue(journal: PauseJournal): Promise<boolean> {
  if (structuredQueuePause(journal) === null) {
    return false
  }
  await journal.queuedMessages.liftPause({
    stop: journal.queuedMessages.pause(),
    adoptInto: hostInstance
  })
  return true
}
