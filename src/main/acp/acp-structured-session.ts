// One live ACP agent connection and what Orca keeps beside it, and how its traffic and its
// process's exit reach the journal and the host.

import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  UNVERIFIABLE_TURN_VERDICT,
  type StructuredAgentSessionTurnVerdict
} from '../native-chat/agent-session-wire/structured-agent-session-stale-turn-verdict'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { AcpChildStops } from './acp-dialects/acp-dialect'
import type { AcpSessionEvent } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { AcpStructuredOptions } from './acp-structured-options'
import type { AcpStructuredPrompts } from './acp-structured-prompts'
import type { AcpStructuredTurns } from './acp-structured-turns'

export type AcpStructuredSession = {
  sessionId: string
  fence: number
  acquisitionGeneration: string
  spec: AcpLaunchSpec
  childStops?: AcpChildStops
  /** The agent's process and its protocol, one owner. */
  connection: AcpStructuredConnection
  lane: AcpStructuredLane
  prompts: AcpStructuredPrompts
  options: AcpStructuredOptions
  turns: AcpStructuredTurns
  /** Saved picks the agent refused when this child started. */
  restoreSkipped: readonly string[]
  /** Orca asked this child to stop; its exit is then a requested close. */
  closeRequested: boolean
  /** Why nothing this child says reaches the journal any more; null while it does. */
  journalClosed: string | null
  /** Its exit is proven and the host was told. */
  ended: boolean
  exitObservedAt: number | null
  unbindReadingControl?: () => void
}

/** Every agent frame goes through here once the lane exists: options and commands first, so a
 *  read right after the frame sees them, then the journal. `reattaching`: see `asReattachHistory`. */
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

/** While a chat reattaches, everything the agent sends is replayed history, whatever the agent
 *  marked: marked as replay, the translator drops it and keeps only its usage. */
export function asReattachHistory(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return params
  }
  const meta = '_meta' in params ? params._meta : undefined
  const marked = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta : {}
  return { ...params, _meta: { ...marked, isReplay: true } }
}

/**
 * Nothing more this child says reaches the journal, once: on its exit, or when its connection broke
 * while it may still run. Open requests die, held sends never left Orca, the running send's fate is
 * unknown, and the running turn ends as `verdict` says: `unverifiable` while the child may still
 * run (the host's settlement of its proven exit revises it), interrupted at a proven exit.
 */
export function closeAcpSessionJournal(
  session: AcpStructuredSession,
  reason: string,
  verdict: StructuredAgentSessionTurnVerdict = UNVERIFIABLE_TURN_VERDICT
): void {
  if (session.journalClosed !== null) {
    return
  }
  session.journalClosed = reason
  session.prompts.clear()
  session.turns.end(reason)
  session.lane.apply([{ type: 'session.ended', verdict }])
  session.lane.flush()
  session.lane.dispose()
  session.unbindReadingControl?.()
}

/** The child's proven exit, once: the journal closes if it has not, and the host hears `ended` so
 *  it releases the session. */
export function endAcpStructuredSession(
  session: AcpStructuredSession,
  observedAt: number,
  onEvent: ((event: StructuredAgentSessionEndedEvent) => void) | undefined
): void {
  if (session.ended) {
    return
  }
  session.ended = true
  session.exitObservedAt = observedAt
  const stderr = session.connection.stderrTail()
  // Read at the proven exit: a crash usually ends the agent's stdout before its exit is observed,
  // so the connection's close comes first, but the agent's own last words are what explain it.
  const reason = session.closeRequested
    ? `${session.spec.agent} ACP agent closed by Orca`
    : session.journalClosed !== null && !stderr
      ? session.journalClosed
      : `${session.spec.agent} ACP agent exited${stderr ? `: ${stderr}` : ''}`
  // A death of its own ended the running turn at the exit, as the host's exit settlement reads it
  // (`exitedRootTurnScope`). A close Orca asked for leaves it `unverifiable`; that settlement revises it.
  closeAcpSessionJournal(
    session,
    reason,
    session.closeRequested
      ? UNVERIFIABLE_TURN_VERDICT
      : { state: 'interrupted', completedAt: observedAt }
  )
  const detail = stderr ? providerDiagnostic(stderr, 'person') : undefined
  onEvent?.({
    type: 'ended',
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
