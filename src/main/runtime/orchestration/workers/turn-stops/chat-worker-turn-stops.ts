import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { AGENT_DONE_QUIET_MS } from '../../../../../shared/agent-status/lifecycle/agent-transitions'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import {
  reportWorkerTurnStop,
  type WorkerTurnStopReason,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'
import {
  readChatWorkerPrompt,
  type ChatWorkerPromptReader
} from '../approvals/chat-worker-approval-prompt'
import {
  ChatWorkerApprovalWatch,
  type ChatJournalWatch
} from '../approvals/chat-worker-approval-watch'
import { workerApprovalPayload } from '../approvals/worker-approval'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

// Defer saved-report observation until the installed host is available.
const ADOPT_AFTER_MS = 5_000

type ChatStop = {
  sessionId: string
  stopKey: string
  reason: WorkerTurnStopReason
  awaitsReply?: boolean
  /** A prompt event's journal item id. */
  promptId?: string
}

/** Failures already escalate as chat errors; a stopped or replaced turn is the user's own doing. */
function chatStop(event: AgentSessionTurnCompletionEvent): ChatStop | null {
  if (event.type === 'prompt') {
    const { sessionId, promptId } = event.prompt
    return { sessionId, stopKey: `prompt:${promptId}`, reason: 'needs-input', promptId }
  }
  if (event.type !== 'completion' || event.completion.outcome !== 'success') {
    return null
  }
  const { sessionId, turnId, awaitingUser } = event.completion
  return {
    sessionId,
    stopKey: `turn:${turnId}`,
    reason: awaitingUser ? 'needs-input' : 'finished',
    ...(awaitingUser ? { awaitsReply: true } : {})
  }
}

/** Reports a chat worker whose turn ended (or stopped at a prompt) while its Dispatch is open.
 *  A finished turn waits out the quiet period, as a terminal's does, and while its Dispatch is still
 *  starting: the turn that reported ends just before the follow-up it claimed hands over its task. */
export function chatWorkerTurnStopReporter(
  deps: WorkerTurnStopReportDeps & { openExistingDb?: () => unknown },
  setTimer: (run: () => void, delayMs: number) => void | (() => void) = (run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
  readPrompt: ChatWorkerPromptReader = readChatWorkerPrompt,
  watchJournal?: ChatJournalWatch,
  now: () => number = Date.now
) {
  const generations = new Map<string, number>()
  // A turn begins after its session's previous turn completed; a prompt arrives mid-turn and bounds nothing.
  const previousCompletionAt = new Map<string, number>()
  const lifetime = new AbortController()
  const timers = new Set<() => void>()
  const schedule = (run: () => void, delayMs: number): void => {
    if (lifetime.signal.aborted) {
      return
    }
    let cancel: void | (() => void)
    const stop = () => {
      cancel?.()
      timers.delete(stop)
    }
    timers.add(stop)
    cancel = setTimer(() => {
      timers.delete(stop)
      if (!lifetime.signal.aborted) {
        run()
      }
    }, delayMs)
  }
  const approvals = new ChatWorkerApprovalWatch({
    ...deps,
    readPrompt,
    watchJournal,
    signal: lifetime.signal
  })
  const onTurnAttention = (
    event: AgentSessionTurnCompletionEvent,
    readStatus: (
      sessionId: string
    ) => Pick<AgentSessionStatusSummary, 'status' | 'lastAssistantMessage'> | undefined
  ): void => {
    try {
      if (lifetime.signal.aborted) {
        return
      }
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
      const turnStartedAt = previousCompletionAt.get(sessionId)
      if (event.type === 'completion') {
        previousCompletionAt.set(sessionId, now())
      }
      const stop = chatStop(event)
      const db = stop ? deps.getDb() : null
      if (!stop || !db) {
        return
      }
      // The Dispatch a stop belongs to is one open when it was seen.
      const seen = new Set(
        chatWorkerDispatches(stop.sessionId, db).map(({ dispatch }) => dispatch.id)
      )
      let approval: AgentJournalApprovalItem | null = null
      const deliver = (): void => {
        try {
          if (lifetime.signal.aborted) {
            return
          }
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
          const open = chatWorkerDispatches(stop.sessionId, current).filter(({ dispatch }) =>
            seen.has(dispatch.id)
          )
          if (
            stop.reason === 'finished' &&
            open.some(
              ({ dispatch }) => current.getWorkerDispatch(dispatch.id)?.state === 'starting'
            )
          ) {
            schedule(deliver, AGENT_DONE_QUIET_MS)
            return
          }
          for (const { dispatch, from } of open) {
            if (lifetime.signal.aborted) {
              return
            }
            const candidate =
              approval && stop.promptId
                ? workerApprovalPayload({
                    approvalId: stop.promptId,
                    item: approval,
                    worker: { handle: from, dispatchId: dispatch.id, taskId: dispatch.task_id }
                  })
                : undefined
            // A prompt Orca can't answer either way is a plain prompt: only the worker's chat can.
            const payload = candidate?.allowedActions.length ? candidate : undefined
            reportWorkerTurnStop(
              current,
              { kind: 'local', dispatch },
              {
                from,
                stopKey: stop.stopKey,
                reason: stop.reason,
                // The payload names the prompt; the agent's prose before it adds nothing.
                lastOutput: payload ? undefined : status?.lastAssistantMessage,
                // Unknown for a session's first turn seen here: a duplicate alert beats hiding a stall.
                turnStartedAt,
                ...(stop.awaitsReply ? { awaitsReply: true } : {}),
                ...(payload ? { approval: payload } : {})
              },
              deps
            )
            if (payload) {
              approvals.track(stop.sessionId, payload.approvalId, dispatch.id)
              // Answered between the read and this report: no later journal change would say so.
              void approvals.check(stop.sessionId)
            }
          }
        } catch (error) {
          console.warn('[orchestration] chat worker stop report failed', error)
        }
      }
      if (stop.reason === 'finished') {
        schedule(deliver, AGENT_DONE_QUIET_MS)
      } else if (stop.promptId) {
        // A permission prompt is reported with what it asks; anything else as a plain prompt.
        const promptId = stop.promptId
        void readPrompt(stop.sessionId, promptId)
          .then((prompt) => {
            if (!lifetime.signal.aborted) {
              approval = prompt?.body.resolution.state === 'pending' ? prompt.body : null
            }
          })
          .catch(() => undefined)
          .finally(deliver)
      } else {
        deliver()
      }
    } catch (error) {
      console.warn('[orchestration] chat worker stop report failed', error)
    }
  }
  return {
    onTurnAttention,
    start: () =>
      schedule(() => {
        void Promise.resolve()
          .then(() => {
            if (lifetime.signal.aborted) {
              return
            }
            deps.openExistingDb?.()
            return approvals.adopt()
          })
          .catch((error: unknown) => {
            console.warn('[orchestration] chat worker approval adoption failed', error)
          })
      }, ADOPT_AFTER_MS),
    stop: () => {
      lifetime.abort()
      for (const cancel of timers) {
        cancel()
      }
      generations.clear()
      previousCompletionAt.clear()
    }
  }
}
