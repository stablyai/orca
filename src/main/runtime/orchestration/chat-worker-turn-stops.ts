import type {
  AgentSessionStatusSummary,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import { AGENT_DONE_QUIET_MS } from '../../../shared/agent-transitions'
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

/** Reports a chat worker whose turn ended (or stopped at a prompt) while its Dispatch is open.
 *  Like a terminal stop it waits out the quiet period: the turn that reported ends with its
 *  follow-up's task queued, and only a worker still at rest after that has stopped. */
export function chatWorkerTurnStopReporter(
  deps: WorkerTurnStopReportDeps,
  setTimer: (run: () => void, delayMs: number) => void = (run, delayMs) => {
    setTimeout(run, delayMs).unref?.()
  }
) {
  const latestStops = new Map<string, string>()
  return (
    event: AgentSessionTurnCompletionEvent,
    readStatus: (
      sessionId: string
    ) => Pick<AgentSessionStatusSummary, 'status' | 'lastAssistantMessage'> | undefined
  ): void => {
    try {
      const stop = chatStop(event)
      const db = stop ? deps.getDb() : null
      if (!stop || !db) {
        return
      }
      // The Dispatch a stop belongs to is the one open when it was seen.
      const seen = new Set(
        chatWorkerDispatches(stop.sessionId, db).map(({ dispatch }) => dispatch.id)
      )
      latestStops.set(stop.sessionId, stop.stopKey)
      setTimer(() => {
        try {
          if (latestStops.get(stop.sessionId) !== stop.stopKey) {
            return
          }
          latestStops.delete(stop.sessionId)
          const current = deps.getDb()
          const status = readStatus(stop.sessionId)
          // A queued follow-up already started the next turn.
          if (!current || status?.status === 'working') {
            return
          }
          for (const { dispatch, from } of chatWorkerDispatches(stop.sessionId, current)) {
            if (!seen.has(dispatch.id)) {
              continue
            }
            reportWorkerTurnStop(
              current,
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
      }, AGENT_DONE_QUIET_MS)
    } catch (error) {
      console.warn('[orchestration] chat worker stop report failed', error)
    }
  }
}
