import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionEndedEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  UNVERIFIABLE_TURN_VERDICT,
  type StructuredAgentSessionTurnVerdict
} from '../native-chat/agent-session-wire/structured-agent-session-stale-turn-verdict'
import { providerExitStatusText } from '../provider-process/provider-process-exit-status'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { AcpChildStops } from './acp-dialects/acp-dialect'
import { isAcpReadySession, type AcpStructuredChild } from './acp-structured-child'
import { acpAgentName } from './acp-structured-agent-definitions'
import type { AcpSessionEvent } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { AcpStructuredOptions } from './acp-structured-options'
import type { AcpStructuredPrompts } from './acp-structured-prompts'
import type { AcpStructuredTurns } from './acp-structured-turns'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'

export type AcpStructuredSession = {
  events?: StructuredAgentSessionEventSink
  sessionId: string
  fence: number
  acquisitionGeneration: string
  spec: AcpLaunchSpec
  childStops?: AcpChildStops
  connection: AcpStructuredConnection
  lane: AcpStructuredLane
  prompts: AcpStructuredPrompts
  options: AcpStructuredOptions
  turns: AcpStructuredTurns
  closeRequested: boolean
  /** Null while provider events can still reach the journal. */
  journalClosed: string | null
  /** Exit was proven and reported to the host. */
  ended: boolean
  exitObservedAt: number | null
  unbindReadingControl?: () => void
  open: (signal: AbortSignal) => Promise<StructuredAgentSessionProviderOpenResult>
}

/** Update options before journaling so synchronous reads see the latest frame. */
export function routeAcpSessionEvent(
  session: Pick<AcpStructuredSession, 'lane' | 'options'>,
  event: AcpSessionEvent,
  at: number,
  reattaching = false
): void {
  if (event.kind === 'known') {
    const { update } = event.notification
    if (update.sessionUpdate === 'available_commands_update') {
      session.options.adoptCommands(update.availableCommands)
    } else if (update.sessionUpdate === 'config_option_update') {
      session.options.adoptConfigOptions(update.configOptions)
    }
  }
  const { translator } = session.lane
  session.lane.apply(
    reattaching
      ? translator.notification(
          'session/update',
          asReattachHistory(event.kind === 'known' ? event.notification : event.raw),
          at
        )
      : translator.sessionEvent(event, at)
  )
}

/** Treat all reattach traffic as history, even without provider replay marks. */
export function asReattachHistory(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return params
  }
  const meta = '_meta' in params ? params._meta : undefined
  const marked = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta : {}
  return { ...params, _meta: { ...marked, isReplay: true } }
}

/** Called only by the acquisition's completed-input closure, independently of process proof. */
export function retireAcpSessionInput(
  session: AcpStructuredChild | null,
  lane: AcpStructuredLane | null,
  at: number,
  cause?: Error
): void {
  if (!isAcpReadySession(session)) {
    lane?.flush()
    lane?.dispose()
    session?.unbindReadingControl?.()
    return
  }
  const interrupted =
    session.journalClosed === null && !session.closeRequested && session.connection.exited
  const endedAt = session.exitObservedAt ?? at
  const verdict: StructuredAgentSessionTurnVerdict = interrupted
    ? { state: 'interrupted', completedAt: endedAt }
    : UNVERIFIABLE_TURN_VERDICT
  session.journalClosed ??= session.closeRequested
    ? `${session.spec.agent} ACP agent closed by Orca`
    : `${session.spec.agent} ACP agent exited`
  const reason = acpSessionEndReason(session)
  session.events?.observeExit?.(session.turns.heldSends)
  session.prompts.clear()
  session.turns.end(reason, cause)
  session.lane.apply([{ type: 'session.ended', verdict, endedAt }])
  session.lane.flush()
  session.lane.dispose()
  session.unbindReadingControl?.()
}

function acpSessionEndReason(session: AcpStructuredSession): string {
  const stderr = session.connection.stderrTail()
  const how = providerExitStatusText(session.connection.exitStatus)
  // Process exit can follow stream loss; keep that earlier reason when stderr is absent.
  const lead =
    session.journalClosed !== null && !stderr
      ? session.journalClosed
      : `${session.spec.agent} ACP agent exited`
  return session.closeRequested
    ? `${session.spec.agent} ACP agent closed by Orca`
    : `${lead}${how ? ` ${how}` : ''}${stderr ? `: ${stderr}` : ''}`
}

export function endAcpStructuredSession(
  session: AcpStructuredSession,
  observedAt: number,
  onEvent: ((event: StructuredAgentSessionEndedEvent) => void) | undefined
): void {
  if (session.ended) {
    return
  }
  observedAt = session.exitObservedAt ?? observedAt
  session.ended = true
  session.events?.observeExit?.(undefined, observedAt)
  session.exitObservedAt = observedAt
  const stderr = session.connection.stderrTail()
  const how = providerExitStatusText(session.connection.exitStatus)
  const reason = acpSessionEndReason(session)
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
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    observedAt
  })
}

/** Only for a send refused before its prompt was written. */
export function rejectedAcpDispatch(
  session: Pick<AcpStructuredSession, 'spec'>
): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('providerExited', { neverReachedAgent: true }),
      { surface: 'rejection', agentName: acpAgentName(session.spec.agent) }
    )
  }
}
