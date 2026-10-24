import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import { settleClaudeTurnEndWaiters } from './claude-request-end-wait'

/** Serialize completed-turn cursor writes; persistence failures must not fail the turn. */
export function persistClaudeTurnResumePoint(
  sessionId: string,
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistResumePoint'>
): void {
  if (session.closeFinalization || session.closeFinalized) {
    return
  }
  session.turnEndLeafUuid = session.leafUuid
  settleClaudeTurnEndWaiters(session)
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
        // Allow retry at the next turn end even if the leaf stays unchanged.
        if (session.resumePointWrite === write) {
          session.resumePointWrite = undefined
        }
      })
  }
  session.resumePointWrite = write
}

/** Drain turn-end writes before close or exit persists the final cursor. */
export async function settledClaudeTurnEndLeaf(session: ClaudeSession): Promise<string | null> {
  await session.resumePointWrite?.settled
  return session.turnEndLeafUuid
}
