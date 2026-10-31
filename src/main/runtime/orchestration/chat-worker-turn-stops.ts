import type {
  AgentSessionStatusSummary,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import {
  reportWorkerTurnStop,
  type WorkerTurnStopReason,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'

type ChatStop = {
  sessionId: string
  stopKey: string
  reason: WorkerTurnStopReason
}

/** Failures already escalate as chat errors; a stopped or replaced turn is the user's own doing. */
function chatStop(event: AgentSessionTurnCompletionEvent): ChatStop | null {
  if (event.type === 'prompt') {
    const { sessionId, promptId } = event.prompt
    return { sessionId, stopKey: `prompt:${promptId}`, reason: 'needs-input' }
  }
  if (event.type !== 'completion' || event.completion.outcome !== 'success') {
    return null
  }
  const { sessionId, turnId, awaitingUser } = event.completion
  return {
    sessionId,
    stopKey: `turn:${turnId}`,
    reason: awaitingUser ? 'needs-input' : 'finished'
  }
}

/** Reports a chat worker whose turn ended (or stopped at a prompt) while its Dispatch is open. */
export function chatWorkerTurnStopReporter(deps: WorkerTurnStopReportDeps) {
  return (
    event: AgentSessionTurnCompletionEvent,
    readStatus: (
      sessionId: string
    ) => Pick<AgentSessionStatusSummary, 'status' | 'lastAssistantMessage'> | undefined
  ): void => {
    try {
      const stop = chatStop(event)
      const db = stop ? deps.getDb() : null
      const status = stop ? readStatus(stop.sessionId) : undefined
      // A queued follow-up already started the next turn.
      if (!stop || !db || status?.status === 'working') {
        return
      }
      for (const { dispatch, from } of chatWorkerDispatches(stop.sessionId, db)) {
        reportWorkerTurnStop(
          db,
          { kind: 'local', dispatch },
          {
            from,
            stopKey: stop.stopKey,
            reason: stop.reason,
            lastOutput: status?.lastAssistantMessage
          },
          deps
        )
      }
    } catch (error) {
      console.warn('[orchestration] chat worker stop report failed', error)
    }
  }
}
