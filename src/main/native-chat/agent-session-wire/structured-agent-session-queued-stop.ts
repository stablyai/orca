// A Stop's event and the queue. A Stop never withdraws a draft and no text ever
// travels back over the wire: where it takes effect it appends ONE Stop event
// (`JournalStopEvent`), and the queue's pause is derived from it
// (`queued-message-pause.ts`) until a turn a person asked for is sent after it, or
// they Resume. The cards stay published, and Send-now sends one card without lifting
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

/** The one unsettled-card predicate /clear's carry and the budget share:
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
 * Whether a Stop reaching a running agent stops anything no Stop event records yet. Not when it
 * names a turn already over (a late Stop from a phone), nor when it repeats the Stop still in force
 * with nothing sent since, on the same turn or one that opened after a Stop pressed before any
 * turn showed: a card queued between the presses then sends normally, as after one Stop.
 */
export function stopReachesUnrecordedWork(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence'>,
  namedTurnId: string | undefined
): boolean {
  const live = ctx.journal.activeTurnId()
  // No turn published yet while the agent works: the named one may still be opening.
  if (
    structuredAgentSessionStopNamesTurnNotLive(namedTurnId, live) &&
    (live !== null || !isMainAgentWorking(ctx))
  ) {
    return false
  }
  const inForce = ctx.journal.queuedMessages.userStopInForce()
  if (inForce === null) {
    return true
  }
  // Sent after that Stop and not refused, even if its fate is unknown: this interrupt may send it
  // back to waiting, so this Stop must hold it. A send with no sequence is an older host's.
  const sentSince = ctx.journal
    .submissions()
    .some(
      (entry) =>
        entry.dispatchState !== 'rejected' &&
        entry.acceptedSequence !== undefined &&
        entry.acceptedSequence > inForce.sequence
    )
  return sentSince || structuredAgentSessionStopNamesTurnNotLive(inForce.event.turnId, live)
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
