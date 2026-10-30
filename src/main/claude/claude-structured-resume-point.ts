import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './structured/claude-structured-session-state'
import { settleClaudeTurnEndWaiters } from './claude-request-end-wait'
import { isRootClaudeFrame } from './claude-turn-opening'

export function claudeTurnResumePointWriter(
  sessionId: string,
  sessions: ReadonlyMap<string, ClaudeSession>,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistResumePoint'>
) {
  return (
    session: ClaudeSession | null,
    message: Record<string, unknown>,
    leafUuid: string | null
  ): void => {
    if (session && message.type === 'result' && isRootClaudeFrame(message)) {
      persistClaudeTurnResumePoint(
        sessionId,
        session,
        deps,
        () => sessions.get(sessionId) === session,
        leafUuid
      )
    }
  }
}

/** Serialize completed-turn cursor writes; persistence failures must not fail the turn. */
function persistClaudeTurnResumePoint(
  sessionId: string,
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistResumePoint'>,
  isCurrent: () => boolean,
  leafUuid: string | null
): void {
  // Ending a request never waits for optional history or durable bookkeeping.
  settleClaudeTurnEndWaiters(session)
  const translator = session.translator
  if (
    !session.initialization.history.covered ||
    !translator?.finalOutputAdmitted ||
    translator.currentTurnId !== null ||
    translator.pendingStreamedBlocks > 0
  ) {
    return
  }
  const persist = deps.persistResumePoint
  if (leafUuid === null || session.resumePointWrite?.leafUuid === leafUuid) {
    return
  }
  const written = session.events
    ?.written?.()
    .catch((error: unknown) => ({ ok: false as const, error }))
  if (!written) {
    return
  }
  const previous = session.resumePointWrite?.settled ?? Promise.resolve()
  const write: NonNullable<ClaudeSession['resumePointWrite']> = {
    leafUuid,
    settled: previous
      .then(async () => {
        const result = await written
        if (!result.ok) {
          throw result.error
        }
        // Close and exit still consume this session's completed output after removing its owner.
        session.turnEndLeafUuid = leafUuid
        if (!isCurrent()) {
          return
        }
        await persist?.({
          sessionId,
          providerSessionId: session.providerSessionId,
          leafUuid,
          fence: session.fence
        })
      })
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
