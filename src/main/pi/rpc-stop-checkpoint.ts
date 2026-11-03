import type { PiRpcSession, PiRpcSessionDeps } from './rpc-session'

/** Wait briefly for a stopped turn to leave, then read state so Pi saves its checkpoint. */
export async function awaitPiStoppedRequestEnd(
  session: PiRpcSession | undefined,
  sessionId: string,
  at: number,
  logger: PiRpcSessionDeps['logger']
): Promise<void> {
  const turn = session?.lane.openTurnId
  if (!session) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (turn) {
      await Promise.race([
        session.lane.whenTurnLeaves(turn),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, at + 2_000 - Date.now()))
          timer.unref()
        })
      ])
    }
  } finally {
    clearTimeout(timer)
  }
  try {
    await session.connection.request('get_state', {}, { timeoutMs: 1_000 })
  } catch (error) {
    logger.warn('Pi checkpoint could not be read before stopping', {
      scope: 'pi-stop-checkpoint',
      sessionId,
      error
    })
  }
}
