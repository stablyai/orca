import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { SubmissionRejectionFact } from '../../shared/agent-session-failure'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { StructuredAgentSessionSetOptionInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AcpAgentError } from './acp-errors'
import { acpAuthenticationRequired, acpSignInRequiredFailure } from './acp-turn-failures'
import type { AcpStructuredSession } from './acp-structured-session'

export type AcpStructuredChild = Pick<
  AcpStructuredSession,
  | 'events'
  | 'sessionId'
  | 'fence'
  | 'acquisitionGeneration'
  | 'spec'
  | 'connection'
  | 'closeRequested'
  | 'journalClosed'
  | 'ended'
  | 'exitObservedAt'
> & {
  lane: AcpStructuredSession['lane'] | null
  turns: AcpStructuredSession['turns'] | null
  options: AcpStructuredSession['options']
  prompts: AcpStructuredSession['prompts']
  childStops?: AcpStructuredSession['childStops']
  unbindReadingControl?: () => void
  open: (signal: AbortSignal) => Promise<StructuredAgentSessionProviderOpenResult>
  closing?: Promise<boolean>
}

export function isAcpReadySession(
  session: AcpStructuredChild | null | undefined
): session is AcpStructuredSession & AcpStructuredChild {
  return session != null && session.lane !== null && session.turns !== null
}

export function canSetAcpOptionWhileIdle(
  session: AcpStructuredChild | undefined,
  input: StructuredAgentSessionSetOptionInput
): boolean {
  return !!(
    session &&
    isAcpReadySession(session) &&
    session.fence === input.fence &&
    session.journalClosed === null &&
    !session.closeRequested &&
    !session.turns.running &&
    input.key === 'model' &&
    session.options.write('model', input.value)?.method === 'config'
  )
}

export function acpStartupFailure(
  session: AcpStructuredChild,
  error: unknown
): SubmissionRejectionFact | undefined {
  if (error instanceof AcpAgentError && acpAuthenticationRequired(session.spec.dialect, error)) {
    // Use the agent's sign-in answer, excluding preceding diagnostic output.
    return acpSignInRequiredFailure(session.spec.dialect, error)
  }
  return undefined
}

export function assertAcpStartingSession(
  session: AcpStructuredChild,
  abandoned: () => boolean
): void {
  if (
    session.ended ||
    session.closeRequested ||
    session.journalClosed !== null ||
    session.connection.exited ||
    session.connection.closed ||
    abandoned()
  ) {
    throw new Error(
      session.connection.stderrTail() || `${session.spec.command} closed while starting`
    )
  }
}

export function observeAcpChildExit(
  getSession: () => AcpStructuredChild | null,
  observedAt: number,
  inputDone: Promise<void> | undefined,
  onExit: (session: AcpStructuredChild | null) => void,
  onConnectionLost: (session: AcpStructuredChild | null, error: Error) => void
): void | Promise<void> {
  const session = getSession()
  if (session) {
    session.exitObservedAt ??= observedAt
    session.events?.observeExit?.(session.turns?.heldSends, observedAt)
  }
  return inputDone
    ? inputDone.then(
        () => onExit(getSession()),
        (error: unknown) => {
          onConnectionLost(getSession(), error instanceof Error ? error : new Error(String(error)))
          onExit(getSession())
        }
      )
    : onExit(session)
}

export function assertAcpBeforeSpawn(abandoned: () => boolean, agentName: string): void {
  if (abandoned()) {
    throw new AgentSessionPreSpawnError(new Error(`${agentName} was closed before it started`))
  }
}

export function requireAcpLiveSession(
  session: AcpStructuredChild | undefined,
  agent: string,
  sessionId: string
): AcpStructuredSession {
  if (
    !session ||
    !isAcpReadySession(session) ||
    session.journalClosed !== null ||
    session.closeRequested ||
    session.connection.closed
  ) {
    throw new Error(`no live ${agent} child owns ${sessionId}`)
  }
  return session
}
