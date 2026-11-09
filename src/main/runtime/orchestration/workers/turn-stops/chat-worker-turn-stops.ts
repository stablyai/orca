import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { AGENT_DONE_QUIET_MS } from '../../../../../shared/agent-status/lifecycle/agent-transitions'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import {
  reportWorkerTurnStop,
  workerTurnStopDispatchId,
  type WorkerTurnStopDispatch,
  type WorkerTurnStopReason,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { resolveStructuredWorkerIdentityForSession } from '../../terminal-authority/structured-sessions/structured-worker-authority'

/** The open Dispatches a chat works: its own here, or one a coordinator on another computer started here. */
function chatWorkerTargets(
  sessionId: string,
  db: OrchestrationDb
): { target: WorkerTurnStopDispatch; from: string; starting: boolean }[] {
  const local = chatWorkerDispatches(sessionId, db).map(({ dispatch, from }) => ({
    target: { kind: 'local' as const, dispatch },
    from,
    starting: db.getWorkerDispatch(dispatch.id)?.state === 'starting'
  }))
  if (local.length > 0) {
    return local
  }
  // A paired server holds its remote workers as attachments; their Dispatch lives at the Run home.
  const worker = resolveStructuredWorkerIdentityForSession(sessionId, db)
  const attachment = worker && db.findActiveRemoteAttachmentForPane(worker.paneKey)
  return worker &&
    attachment &&
    db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey: worker.paneKey,
      processIncarnation: worker.processIncarnation
    })
    ? [
        {
          target: { kind: 'remote', attachment },
          from: worker.handle,
          starting: attachment.state === 'starting'
        }
      ]
    : []
}

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
 *  A finished turn waits out the quiet period, as a terminal's does, and while its Dispatch is still
 *  starting: the turn that reported ends just before the follow-up it claimed hands over its task. */
export function chatWorkerTurnStopReporter(
  deps: WorkerTurnStopReportDeps,
  setTimer: (run: () => void, delayMs: number) => void = (run, delayMs) => {
    setTimeout(run, delayMs).unref?.()
  }
) {
  const generations = new Map<string, number>()
  return (
    event: AgentSessionTurnCompletionEvent,
    readStatus: (
      sessionId: string
    ) => Pick<AgentSessionStatusSummary, 'status' | 'lastAssistantMessage'> | undefined
  ): void => {
    try {
      const sessionId =
        event.type === 'completion'
          ? event.completion.sessionId
          : event.type === 'prompt'
            ? event.prompt.sessionId
            : undefined
      if (!sessionId) {
        return
      }
      // Any later edge, even one not reported (a failed or cancelled turn), supersedes a pending stop.
      const generation = (generations.get(sessionId) ?? 0) + 1
      generations.set(sessionId, generation)
      const stop = chatStop(event)
      const db = stop ? deps.getDb() : null
      if (!stop || !db) {
        return
      }
      // The Dispatch a stop belongs to is one open when it was seen.
      const seen = new Set(
        chatWorkerTargets(stop.sessionId, db).map(({ target }) => workerTurnStopDispatchId(target))
      )
      const deliver = (): void => {
        try {
          const current = deps.getDb()
          const status = readStatus(stop.sessionId)
          // A newer edge supersedes this one, and a queued follow-up already started the next turn.
          if (
            generations.get(stop.sessionId) !== generation ||
            !current ||
            status?.status === 'working'
          ) {
            return
          }
          const open = chatWorkerTargets(stop.sessionId, current).filter(({ target }) =>
            seen.has(workerTurnStopDispatchId(target))
          )
          if (stop.reason === 'finished' && open.some(({ starting }) => starting)) {
            setTimer(deliver, AGENT_DONE_QUIET_MS)
            return
          }
          for (const { target, from } of open) {
            reportWorkerTurnStop(
              current,
              target,
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
      if (stop.reason === 'finished') {
        setTimer(deliver, AGENT_DONE_QUIET_MS)
      } else {
        deliver()
      }
    } catch (error) {
      console.warn('[orchestration] chat worker stop report failed', error)
    }
  }
}
