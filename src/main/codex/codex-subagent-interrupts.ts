import { CodexAppServerTimeoutError } from './codex-app-server-session'
import type { CodexSession } from './codex-structured-session-state'
import { interruptCodexTurn } from './codex-structured-turn-cancellation'

export type CodexSubagentTurn = { threadId: string; turnId: string }

/** Report surviving refusals; throw unknown transport failures only when no survivor is known. */
export async function interruptCodexSubagents(
  session: CodexSession,
  turns: readonly CodexSubagentTurn[],
  options: {
    timeoutMs: number
    isCurrent: () => boolean
    ended: (turn: CodexSubagentTurn) => boolean
  }
): Promise<{ stopped: number; survived: boolean }> {
  let stopped = 0
  let survived = false
  let failure: { error: unknown } | undefined
  for (const turn of turns) {
    if (!options.isCurrent()) {
      break
    }
    try {
      const outcome = await interruptCodexTurn({
        session,
        ...turn,
        requestTimeoutMs: options.timeoutMs
      })
      if (outcome.cancelled) {
        stopped += 1
      } else if (!outcome.refusal?.turnNotRunning) {
        survived = true
      }
    } catch (error) {
      // An interrupt racing turn end can await the next turn; observed completion resolves that timeout.
      const timedOut = error instanceof CodexAppServerTimeoutError
      if (timedOut && options.isCurrent() && options.ended(turn)) {
        continue
      }
      failure ??= { error }
      // Avoid another full deadline for every child on an unresponsive server.
      if (timedOut) {
        break
      }
    }
  }
  if (failure && !survived) {
    throw failure.error
  }
  return { stopped, survived }
}
