// A Stop's event and the queue. A Stop never withdraws a draft and no text ever
// travels back over the wire: where it takes effect it appends ONE Stop event
// (`JournalStopEvent`), and the queue's pause is derived from it
// (`queued-message-pause.ts`) until any turn is sent after it and accepted, or the
// person Resumes. The cards stay published, and Send-now sends one card without lifting
// the pause for the rest until that card's turn starts. The event is bookkeeping: a
// failure is reported and never gates the interrupt.

import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { isMainAgentWorking } from './structured-agent-session-turns-cancel'
import {
  structuredAgentSessionStopNamesTurnNotLive,
  structuredAgentSessionStoppedTurnId
} from './structured-agent-session-turn-stop-notes'

/** The one unsettled-card predicate /clear's carry and the published-bytes bound share:
 *  waiting or returned. Pending/unknown/accepted deliveries stay outside it. */
export function unsettledQueuedMessages(journal: AgentSessionJournal): QueuedMessageRow[] {
  return journal.queuedMessages.list().filter(isUnsettledQueuedMessage)
}

/**
 * Runs a Stop, which calls `tookEffect` where it takes effect: after it issued the withdrawal of
 * the queued sends, and BEFORE the interrupt or anything that ends the child (the at-start stop, a
 * running command's stop, a kill after the interrupt), or, reaching no agent, once it withdrew
 * something. That issues the Stop's event, whatever the queue holds, so a card its interrupt later
 * withdraws comes back to waiting under the pause, and whatever ends the child finds the event
 * ahead of it in the journal. A Stop that throws before then, or stops nothing
 * (`stopReachesUnrecordedWork`), changed nothing and writes nothing.
 * The drain cannot slip a card in between: the Stop runs on the drain's serialized lane and holds
 * it until the event lands, even when it fails.
 */
export async function runRecordedStop<TValue>(
  ctx: AgentSessionTurnContext,
  /** `turnId` absent: the turn running when the Stop takes effect, if any. */
  event: Omit<JournalStopEvent, 'at'>,
  stop: (tookEffect: () => Promise<void>) => Promise<TurnOutcome<TValue>>
): Promise<TurnOutcome<TValue>> {
  const skipped = (error: unknown): void => report(ctx, 'event row', error)
  return stop(() => {
    try {
      const turnId = structuredAgentSessionStoppedTurnId(ctx.journal, event.turnId) ?? undefined
      return ctx.journal
        .appendStopEvent({ ...event, ...(turnId ? { turnId } : {}) }, ctx.fence)
        .then(() => undefined, skipped)
    } catch (error) {
      // A throw before the append is queued is reported too: the Stop still interrupts.
      skipped(error)
      return Promise.resolve()
    }
  })
}

/**
 * What a Stop reaching a running agent stops: work no Stop event records yet (`unrecorded`), or
 * only what the Stop still in force already records, which it repeats with nothing sent since, on
 * the same turn or one that opened after a Stop pressed before any turn showed (`repeat`): a card
 * queued between the presses then sends normally, as after one Stop. `late`: it names a turn
 * already over, as a late Stop from a phone can.
 */
export function stopReachesUnrecordedWork(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence'>,
  namedTurnId: string | undefined
): 'unrecorded' | 'repeat' | 'late' {
  const live = ctx.journal.activeTurnId()
  // No turn published yet while the agent works: the named one may still be opening.
  if (
    structuredAgentSessionStopNamesTurnNotLive(namedTurnId, live) &&
    (live !== null || !isMainAgentWorking(ctx))
  ) {
    return 'late'
  }
  const inForce = ctx.journal.queuedMessages.userStopInForce()
  if (inForce === null) {
    return 'unrecorded'
  }
  // This interrupt may send a later send back to waiting, so this Stop must hold it.
  return sentSinceStop(ctx.journal, inForce) ||
    structuredAgentSessionStopNamesTurnNotLive(inForce.event.turnId, live)
    ? 'unrecorded'
    : 'repeat'
}

/** Whether anything was sent after the Stop in force and not refused, even if its fate is
 *  unknown. A send with no sequence is an older host's. */
export function sentSinceStop(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  inForce: { sequence: number }
): boolean {
  return journal
    .submissions()
    .some(
      (entry) =>
        entry.dispatchState !== 'rejected' &&
        entry.acceptedSequence !== undefined &&
        entry.acceptedSequence > inForce.sequence
    )
}

/** The Stop's withdrawal of every queued send, issued at once and never awaited ahead of the
 *  interrupt. Bookkeeping: one that fails is reported and withdrew nothing. */
export function withdrawQueuedForStop(
  ctx: AgentSessionTurnContext,
  withdraw: () => Promise<readonly string[]>
): Promise<boolean> {
  const failed = (error: unknown): boolean => {
    report(ctx, 'withdrawal', error)
    return false
  }
  try {
    return withdraw().then((withdrawn) => withdrawn.length > 0, failed)
  } catch (error) {
    return Promise.resolve(failed(error))
  }
}

function report(ctx: AgentSessionTurnContext, step: string, error: unknown): void {
  ctx.logger.warn(`Stop's ${step} failed`, {
    scope: 'stop-queued-bookkeeping',
    sessionId: ctx.sessionId,
    step,
    error
  })
}
