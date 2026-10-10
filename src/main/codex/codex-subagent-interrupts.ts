// Stopping a Codex sub-agent: its thread is an ordinary loaded thread on the same app-server, so
// `turn/interrupt` names the child thread and the turn it runs. Codex answers when that turn ends,
// aborted or not, and the child's own `turn/completed` then removes its row.

import { CodexAppServerTimeoutError } from './codex-app-server-session'
import type { CodexSession } from './codex-structured-session-state'
import { interruptCodexTurn } from './codex-structured-turn-cancellation'

/** One child run a Stop names: the child's thread and the turn the host last saw it working on. */
export type CodexSubagentTurn = { threadId: string; turnId: string }

/**
 * Interrupts each named run. A refusal saying the turn is not running means the run is over:
 * nothing to stop. Any other refusal leaves the child running. Throws when a request got no answer
 * and no refusal said a child survived, since the effect is then unknown; every other child is
 * tried first.
 */
export async function interruptCodexSubagents(
  session: CodexSession,
  turns: readonly CodexSubagentTurn[],
  options: {
    timeoutMs: number
    isCurrent: () => boolean
    /** Whether the session has since seen this run end. */
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
      // Codex holds an interrupt that lands as the turn ends, answering it only when the child's
      // next turn ends; that one runs on. A run seen ended had nothing left to stop.
      const timedOut = error instanceof CodexAppServerTimeoutError
      if (timedOut && options.isCurrent() && options.ended(turn)) {
        continue
      }
      failure ??= { error }
      // An app-server that is not answering would make every later request wait out its deadline.
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
