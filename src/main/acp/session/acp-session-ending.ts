import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'

import type { StructuredAgentSessionEndedEvent } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  UNVERIFIABLE_TURN_VERDICT,
  type StructuredAgentSessionTurnVerdict
} from '../../native-chat/agent-session-wire/termination/structured-agent-session-stale-turn-verdict'

import { providerExitStatusText } from '../../provider-process/provider-process-exit-status'
import type { AcpStructuredSession } from './acp-structured-session-contract'

/** Close journaling once; unproven exits remain unverifiable until the host settles them. */
export function closeAcpSessionJournal(
  session: AcpStructuredSession,
  reason: string,
  cause?: Error,
  verdict: StructuredAgentSessionTurnVerdict = UNVERIFIABLE_TURN_VERDICT,
  endedAt: number = Date.now()
): void {
  if (session.journalClosed !== null) {
    return
  }
  session.events?.observeExit?.(session.turns.heldSends)
  session.historyCatchUp?.abort()
  session.journalClosed = reason
  session.prompts.clear()
  session.turns.end(reason, cause)
  session.lane.apply([{ type: 'session.ended', verdict, endedAt }])
  session.lane.flush()
  session.lane.dispose()
  session.unbindReadingControl?.()
}

export function endAcpStructuredSession(
  session: AcpStructuredSession,
  observedAt: number,
  onEvent: ((event: StructuredAgentSessionEndedEvent) => void) | undefined
): void {
  if (session.ended) {
    return
  }
  // Publishing the ending can re-enter cleanup, so attribution comes from before it.
  const failureClose = session.failureClose
  session.ended = true
  session.events?.observeExit?.(undefined, observedAt)
  session.exitObservedAt = observedAt
  const stderr = session.connection.stderrTail()
  const how = providerExitStatusText(session.connection.exitStatus)
  // Orca's own close (stream loss, refusal) names the cause; the agent's stderr stays beside it.
  const lead = failureClose ?? session.journalClosed ?? `${session.spec.agent} ACP agent exited`
  const reason = session.closeRequested
    ? `${session.spec.agent} ACP agent closed by Orca`
    : `${lead}${how ? ` ${how}` : ''}${stderr ? `: ${stderr}` : ''}`
  // Spontaneous exit interrupts now; requested close leaves the host to revise an unverifiable turn.
  closeAcpSessionJournal(
    session,
    reason,
    undefined,
    session.closeRequested
      ? UNVERIFIABLE_TURN_VERDICT
      : { state: 'interrupted', completedAt: observedAt },
    observedAt
  )
  // The tail spans the whole run, so a startup warning can still be in it: a log, not the cause.
  const detail = providerDiagnostic([how, stderr].filter(Boolean).join('\n'), 'log')
  onEvent?.({
    type: 'ended',
    ...(session.connection.lastCloseResult?.killDelivered && !session.connection.exited
      ? { deathEvidenceKind: 'kill-delivered' as const }
      : {}),
    sessionId: session.sessionId,
    reason,
    failure: session.closeRequested
      ? agentSessionFailureFact('hostFault')
      : agentSessionFailureFact('providerExited', detail ? { detail } : {}),
    cause: session.closeRequested ? 'requested-close' : 'unexpected-exit',
    ...(failureClose !== null && !session.closeRequested ? { closedByOrca: true as const } : {}),
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    observedAt
  })
}
