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
