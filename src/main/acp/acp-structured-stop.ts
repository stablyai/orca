// How a running ACP turn ends before its child does, for a Stop and a requested close alike: the
// cancel goes out once, and the agent gets a bounded grace, counted from it, to end its turn.

import type { AcpStructuredSession } from './acp-structured-session'

type AcpStoppableSession = Pick<AcpStructuredSession, 'connection' | 'lane' | 'prompts' | 'turns'>

/** A turn a cancel can end: Orca's prompt, or one the agent opened itself. */
function acpTurnInFlight(session: AcpStoppableSession): boolean {
  return session.turns.running || session.lane.openTurnId !== null
}

/** As a Stop: held steers and the agent's open requests are withdrawn, then the cancel is written,
 *  never awaited; a failed write leaves the grace to run out. */
export function interruptAcpTurn(session: AcpStoppableSession): void {
  session.turns.stop(Date.now())
  if (!acpTurnInFlight(session)) {
    return
  }
  session.prompts.withdrawAll()
  void session.connection.cancel().catch(() => undefined)
}

/** Resolves once the running turn ended, or `graceMs` after `stoppedAt` (`Date.now()` time). */
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

/** Before a requested close: a running turn is cancelled, unless a Stop already did, and waited on
 *  within the grace that cancel started. */
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
