// Bind Continue to the cut turn; restart offers only select wording and may be absent.

import { createHash, randomUUID } from 'node:crypto'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import {
  continuationDeps,
  RestartContinuationSupersededError,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationHost,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'

export type StructuredAgentSessionInterruptedContinuationOutcome = {
  sessionId: string
  /** Nothing sent: another message or Continue superseded this cut. */
  outcome: StructuredAgentSessionContinuationOutcome['outcome'] | 'superseded'
  reason?: string
}

const hex16 = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

/** Timestamp new ledger IDs at the click; bind identity to the cut turn. */
function interruptedContinuationId(
  sessionId: string,
  turnItemId: string,
  actionAt: number,
  nonce: string
): string {
  return `${Math.trunc(actionAt).toString().padStart(13, '0')}-${hex16([sessionId, turnItemId])}${hex16([sessionId, turnItemId, nonce])}`
}

/** Recheck the cut under serialization; prior acceptance makes concurrent/lost-reply retries no-ops. */
export async function continueInterruptedStructuredAgentSessionTurn(
  host: Omit<StructuredAgentSessionContinuationHost, 'stillResumable'>,
  input: {
    sessionId: string
    turnItemId: string
    /** Optional restart-offer wording for lost background work. */
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
      // A paired client may time out before provider startup completes.
      { ...continuationDeps(host, stillCut), answerAtAcceptance: true },
      sessionId,
      input.offer ?? {},
      continuationId
    )
    if ('verdict' in started) {
      // Answer on acceptance; any later failure is reported by the chat’s own note.
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

/** Offer reads select wording only; bound them so slow recovery files cannot block Continue. */
const OFFER_READ_TIMEOUT_MS = 2_000

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
