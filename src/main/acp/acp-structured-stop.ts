import { isAcpReadySession, type AcpStructuredChild } from './acp-structured-child'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { AcpStructuredSession } from './acp-structured-session'

type AcpStoppableSession = Pick<AcpStructuredSession, 'connection' | 'lane' | 'prompts' | 'turns'>

function acpTurnInFlight(session: AcpStoppableSession): boolean {
  return session.turns.running || session.lane.openTurnId !== null
}

/** Do not await the cancel write; grace expiry must still close an unresponsive child. */
export function interruptAcpTurn(session: AcpStoppableSession): void {
  session.turns.stop(Date.now())
  if (!acpTurnInFlight(session)) {
    return
  }
  session.prompts.withdrawAll()
  void session.connection.cancel().catch(() => undefined)
}

/** Wait for turn completion or grace expiry using the Date.now clock. */
export async function awaitAcpTurnEnd(
  session: AcpStoppableSession,
  stoppedAt: number,
  graceMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, stoppedAt + graceMs - Date.now()))
  })
  const turnId = session.lane.openTurnId
  try {
    await Promise.race([
      Promise.all([
        session.turns.whenIdle(),
        turnId === null ? undefined : session.lane.whenTurnLeaves(turnId)
      ]),
      elapsed
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Reuse an earlier Stop's grace deadline rather than starting a new one. */
export async function windDownAcpTurn(
  session: AcpStoppableSession,
  graceMs: number
): Promise<void> {
  const { connection, turns } = session
  if (connection.exited || connection.closed || !acpTurnInFlight(session)) {
    return
  }
  if (turns.stoppedAt === null) {
    interruptAcpTurn(session)
  }
  await awaitAcpTurnEnd(session, turns.stoppedAt ?? Date.now(), graceMs)
}

export async function settleAcpPermissionTransition(
  session: AcpStructuredSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['settlePermissionTransition']>>[0],
  graceMs: number
): Promise<boolean> {
  input.signal?.throwIfAborted()
  if (session.fence !== input.fence || session.closeRequested) {
    return false
  }
  session.turns.interruptForPermissionTransition()
  await waitForPromiseWithSignal(awaitAcpTurnEnd(session, Date.now(), graceMs), input.signal)
  return (
    !session.ended &&
    !session.closeRequested &&
    !session.turns.running &&
    session.lane.openTurnId === null
  )
}

export function requestEndWait(
  sessionFor: (id: string) => AcpStructuredChild | undefined,
  graceMs: () => number
): NonNullable<StructuredAgentSessionAdapter['awaitStoppedRequestEnd']> {
  return async (id, at) => {
    const session = sessionFor(id)
    if (isAcpReadySession(session)) {
      await awaitAcpTurnEnd(session, at, graceMs())
    }
  }
}

export function acpPermissionTransition(
  sessionFor: (id: string) => AcpStructuredSession,
  graceMs: () => number
): NonNullable<StructuredAgentSessionAdapter['settlePermissionTransition']> {
  return (input) => settleAcpPermissionTransition(sessionFor(input.sessionId), input, graceMs())
}
