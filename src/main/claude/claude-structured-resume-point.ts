import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'

/**
 * Record a completed turn: its leaf becomes the one close and exit persist, and the durable point
 * advances in place so an owner that dies before its close path runs keeps it. Writes run one at a
 * time, and a failure is only logged: this is bookkeeping and must never fail the turn.
 */
export function persistClaudeTurnResumePoint(
  sessionId: string,
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistResumePoint'>
): void {
  if (session.closeFinalization || session.closeFinalized) {
    return
  }
  session.turnEndLeafUuid = session.leafUuid
  const leafUuid = session.turnEndLeafUuid
  const persist = deps.persistResumePoint
  if (!persist || leafUuid === null || session.resumePointWrite?.leafUuid === leafUuid) {
    return
  }
  const previous = session.resumePointWrite?.settled ?? Promise.resolve()
  const write: NonNullable<ClaudeSession['resumePointWrite']> = {
    leafUuid,
    settled: previous
      .then(() =>
        persist({
          sessionId,
          providerSessionId: session.providerSessionId,
          leafUuid,
          fence: session.fence
        })
      )
      .catch((error: unknown) => {
        console.warn('[claude-resume-point] turn-end resume point was not persisted:', {
          sessionId,
          leafUuid,
          error
        })
        // Forget the failed leaf so the next turn end retries it even when the leaf has not moved.
        if (session.resumePointWrite === write) {
          session.resumePointWrite = undefined
        }
      })
  }
  session.resumePointWrite = write
}

/** Close and exit persist the last completed turn, after any in-flight turn-end write settles. */
export async function settledClaudeTurnEndLeaf(session: ClaudeSession): Promise<string | null> {
  await session.resumePointWrite?.settled
  return session.turnEndLeafUuid
}
