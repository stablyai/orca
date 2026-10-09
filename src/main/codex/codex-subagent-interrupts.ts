// Stopping a Codex sub-agent: its thread is an ordinary loaded thread on the same app-server, so
// `turn/interrupt` names the child thread and the turn it runs. Codex answers only once that turn
// has aborted, and the child's own `turn/completed` (interrupted) then removes its row.

import type { CodexAppServerConnection } from './codex-app-server-connection'
import { isCodexAppServerRequestError } from './codex-app-server-request-error'
import {
  CodexAppServerTimeoutError,
  isCodexAppServerUnsupportedError
} from './codex-app-server-session'

/** One child run a Stop names: the child's thread and the turn the row showed it running. */
export type CodexSubagentTurn = { threadId: string; turnId: string }

/**
 * Interrupts each named run. Codex's -32600 (no active turn, another turn, thread not found) means
 * the run the row showed is over: nothing to stop. Any other refusal leaves the child running.
 * Throws when a request got no answer and no refusal said a child survived, since the effect is
 * then unknown; every other child is tried first.
 */
export async function interruptCodexSubagents(
  rpc: Pick<CodexAppServerConnection, 'request'>,
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
  for (const { threadId, turnId } of turns) {
    if (!options.isCurrent()) {
      break
    }
    try {
      await rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: options.timeoutMs })
      stopped += 1
    } catch (error) {
      if (isCodexAppServerRequestError(error) && error.code === -32600) {
        continue
      }
      if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
        survived = true
        continue
      }
      // Codex holds an interrupt that lands as the turn ends, answering it only when the child's
      // next turn ends; that one runs on. A run seen ended had nothing left to stop.
      if (
        error instanceof CodexAppServerTimeoutError &&
        options.isCurrent() &&
        options.ended({ threadId, turnId })
      ) {
        continue
      }
      failure ??= { error }
      // An app-server that is not answering would make every later request wait out its deadline.
      if (error instanceof CodexAppServerTimeoutError) {
        break
      }
    }
  }
  if (failure && !survived) {
    throw failure.error
  }
  return { stopped, survived }
}
