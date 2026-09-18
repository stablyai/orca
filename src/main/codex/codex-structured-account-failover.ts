import { isCodexQuotaFailedTurn } from '../codex-accounts/codex-automation-policy'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

export function codexSessionCanFailover(session: CodexSession): boolean {
  return (
    !session.ended &&
    !session.requestedClose &&
    !session.dispatchPending &&
    !session.activeTurnIds?.size &&
    session.prompts.sizes.prompts === 0 &&
    session.dispatchEchoes.size === 0 &&
    !session.backgroundTasks.state
  )
}

export function observeCodexAccountFailover(
  session: CodexSession,
  event: CodexStructuredSessionEvent,
  deps: CodexStructuredSessionAdapterDeps
): void {
  if (
    !deps.failover ||
    event.type !== 'notification' ||
    event.method !== 'turn/completed' ||
    event.threadId !== session.threadId ||
    !isCodexQuotaFailedTurn(event.params) ||
    !session.codexHome ||
    session.failoverPending ||
    !codexSessionCanFailover(session)
  ) {
    return
  }
  session.failoverPending = true
  const controller = new AbortController()
  session.cancelFailover = () => controller.abort()
  void deps
    .failover({
      sessionId: event.sessionId,
      home: session.codexHome,
      threadId: session.threadId,
      historyPath: session.historyPath,
      historyMode: session.historyMode,
      fence: session.fence,
      signal: controller.signal,
      isSafe: () => !controller.signal.aborted && codexSessionCanFailover(session),
      stop: () => session.connection.close()
    })
    .then(async (switched) => {
      if (switched) {
        await session.forceCloseUnexpected?.(
          new Error('Codex account switched after reaching its usage limit.')
        )
      }
    })
    .catch(async () => {
      if (session.connection.closed && !session.ended) {
        await session.forceCloseUnexpected?.(
          new Error('Codex account switch paused. Resume this conversation to continue.')
        )
      }
    })
    .finally(() => {
      session.failoverPending = false
      session.cancelFailover = undefined
    })
}
