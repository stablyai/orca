// Continue, pressed in a chat whose reply an Orca stop cut off: the restart continuation, bound to
// that cut turn rather than to a restart offer. An offer, when one survives, only picks the words;
// none is needed, so a crash or a paired server's restart continues the same way.

import { createHash, randomUUID } from 'node:crypto'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat-orca-stop-cut'
import {
  continuationDeps,
  RestartContinuationSupersededError,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationHost,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'

export type StructuredAgentSessionInterruptedContinuationOutcome = {
  sessionId: string
  /** `superseded`: the chat is no longer sitting on that cut (a message, or another Continue, came
   *  first), so nothing was sent. */
  outcome: StructuredAgentSessionContinuationOutcome['outcome'] | 'superseded'
  reason?: string
}

const hex16 = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

/** Dated by the click, as the ledger requires of a new id; tagged with the cut it continues. */
function interruptedContinuationId(
  sessionId: string,
  turnItemId: string,
  actionAt: number,
  nonce: string
): string {
  return `${Math.trunc(actionAt).toString().padStart(13, '0')}-${hex16([sessionId, turnItemId])}${hex16([sessionId, turnItemId, nonce])}`
}

/**
 * Sends the continuation when, at acceptance inside the session lock, the chat's latest turn is
 * still `turnItemId`, cut by an Orca stop with nothing sent since. A second Continue (another
 * client, a retry after a lost answer) finds the first one's message there and sends nothing.
 */
export async function continueInterruptedStructuredAgentSessionTurn(
  host: Omit<StructuredAgentSessionContinuationHost, 'stillResumable'>,
  input: {
    sessionId: string
    turnItemId: string
    /** The chat's restart offer, when one could be read: its words cover lost background work. */
    offer: Pick<AgentSessionResumeMarker, 'activity'> | null
    nonce: string
  }
): Promise<StructuredAgentSessionInterruptedContinuationOutcome> {
  const { sessionId, turnItemId } = input
  const stillCut = (): boolean => {
    const journal = host.sessions.get(sessionId)?.journal
    return (
      journal !== undefined &&
      latestNativeChatOrcaStopCut(journal.snapshot().items, journal.submissions())?.turnItemId ===
        turnItemId
    )
  }
  const continuationId = interruptedContinuationId(sessionId, turnItemId, host.now(), input.nonce)
  try {
    const started = await startStructuredAgentSessionContinuation(
      // As a send answers: a paired client's wait is shorter than an agent's start can be.
      { ...continuationDeps(host, stillCut), answerAtAcceptance: true },
      sessionId,
      input.offer ?? {},
      continuationId
    )
    if ('verdict' in started) {
      // Accepted: the agent's start and answer can take a whole turn, and the chat's own note
      // reports a failure, so the click is answered now.
      void started.verdict().catch(() => {
        host.logger.warn('settling an interrupted-turn continuation failed', {
          scope: 'interrupted-continuation',
          sessionId
        })
      })
      return { sessionId, outcome: 'pending' }
    }
    return {
      sessionId,
      outcome: started.done.outcome,
      ...(started.done.reason ? { reason: started.done.reason } : {})
    }
  } catch (error) {
    if (error instanceof RestartContinuationSupersededError) {
      return { sessionId, outcome: 'superseded' }
    }
    throw error
  }
}

/** Reading the offer only picks the words, so a slow recovery file never holds Continue. */
const OFFER_READ_TIMEOUT_MS = 2_000

/** Continue for one host: its offer, when one can be read in time, picks the words. */
export function createInterruptedContinuation(
  host: Omit<StructuredAgentSessionContinuationHost, 'stillResumable'>,
  readOffers: () => Promise<readonly AgentSessionResumeMarker[]>
): (
  sessionId: string,
  turnItemId: string
) => Promise<StructuredAgentSessionInterruptedContinuationOutcome> {
  return async (sessionId, turnItemId) => {
    const offers = await withTimeout(
      readOffers().catch(() => []),
      OFFER_READ_TIMEOUT_MS,
      []
    )
    return continueInterruptedStructuredAgentSessionTurn(host, {
      sessionId,
      turnItemId,
      offer: offers.find((offer) => offer.sessionId === sessionId) ?? null,
      nonce: randomUUID()
    })
  }
}
