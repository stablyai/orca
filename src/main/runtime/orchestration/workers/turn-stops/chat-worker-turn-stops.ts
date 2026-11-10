import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { AGENT_DONE_QUIET_MS } from '../../../../../shared/agent-status/lifecycle/agent-transitions'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import {
  reportWorkerApprovalClosed,
  reportWorkerTurnStop,
  type WorkerTurnStop,
  type WorkerTurnStopReason,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'
import {
  ORCHESTRATION_APPROVAL_CALLER_PREFIX,
  readChatWorkerPrompt,
  type ChatWorkerPromptReader
} from '../approvals/chat-worker-approval-prompt'
import { workerApprovalDecisionOf, workerApprovalPayload } from '../approvals/worker-approval'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

type ChatStop = {
  sessionId: string
  stopKey: string
  reason: WorkerTurnStopReason
  waitingOn?: WorkerTurnStop['waitingOn']
  /** A prompt event's journal item id. */
  promptId?: string
}

/** An approval reported open, still to be closed once its prompt settles. */
type ReportedApproval = { dispatchIds: Set<string> }

/** Failures already escalate as chat errors; a stopped or replaced turn is the user's own doing. */
function chatStop(event: AgentSessionTurnCompletionEvent): ChatStop | null {
  if (event.type === 'prompt') {
    const { sessionId, promptId } = event.prompt
    return {
      sessionId,
      stopKey: `prompt:${promptId}`,
      reason: 'needs-input',
      waitingOn: 'prompt',
      promptId
    }
  }
  if (event.type !== 'completion' || event.completion.outcome !== 'success') {
    return null
  }
  const { sessionId, turnId, awaitingUser } = event.completion
  return {
    sessionId,
    stopKey: `turn:${turnId}`,
    reason: awaitingUser ? 'needs-input' : 'finished',
    ...(awaitingUser ? { waitingOn: 'reply' as const } : {})
  }
}

/** Reports a chat worker whose turn ended (or stopped at a prompt) while its Dispatch is open.
 *  A finished turn waits out the quiet period, as a terminal's does, and while its Dispatch is still
 *  starting: the turn that reported ends just before the follow-up it claimed hands over its task. */
export function chatWorkerTurnStopReporter(
  deps: WorkerTurnStopReportDeps,
  setTimer: (run: () => void, delayMs: number) => void = (run, delayMs) => {
    setTimeout(run, delayMs).unref?.()
  },
  readPrompt: ChatWorkerPromptReader = readChatWorkerPrompt
) {
  const generations = new Map<string, number>()
  const reported = new Map<string, Map<string, ReportedApproval>>()

  // Any later edge is a chance to see that a reported approval was answered elsewhere.
  const closeSettledApprovals = async (sessionId: string): Promise<void> => {
    const open = reported.get(sessionId)
    for (const [approvalId, approval] of open ?? []) {
      // An unreadable chat proves nothing: keep watching for the next edge.
      const prompt = await readPrompt(sessionId, approvalId).catch(() => undefined)
      if (prompt === undefined || prompt?.body.resolution.state === 'pending') {
        continue
      }
      open?.delete(approvalId)
      // One closer each: Orca's own answer writes its closing line, with the reason; a vanished prompt has nothing to say.
      if (
        !prompt ||
        prompt.body.resolution.resolvedBy?.startsWith(ORCHESTRATION_APPROVAL_CALLER_PREFIX)
      ) {
        continue
      }
      closeEach(approval, approvalId, prompt.body)
    }
    // An overlapping call may have replaced this session's map; remove only the one this call read.
    if (open?.size === 0 && reported.get(sessionId) === open) {
      reported.delete(sessionId)
    }
  }

  const closeEach = (
    approval: ReportedApproval,
    approvalId: string,
    body: AgentJournalApprovalItem
  ): void => {
    const db = deps.getDb()
    if (!db) {
      return
    }
    for (const dispatchId of approval.dispatchIds) {
      const dispatch = db.getDispatchContextById(dispatchId)
      const handle = dispatch?.assignee_handle
      if (!dispatch || !handle) {
        continue
      }
      const decision = workerApprovalDecisionOf(body)
      reportWorkerApprovalClosed(
        db,
        dispatch,
        {
          from: handle,
          approval: workerApprovalPayload({
            approvalId,
            item: body,
            worker: {
              handle,
              dispatchId,
              taskId: dispatch.task_id
            },
            outcome: {
              by: body.resolution.state === 'resolved' ? 'worker-chat' : 'unknown',
              decision,
              reason: null,
              reasonDelivered: false
            }
          })
        },
        deps
      )
    }
  }

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
      if (reported.has(sessionId)) {
        void closeSettledApprovals(sessionId).catch((error: unknown) => {
          console.warn('[orchestration] chat worker approval close failed', error)
        })
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
        chatWorkerDispatches(stop.sessionId, db).map(({ dispatch }) => dispatch.id)
      )
      let approval: AgentJournalApprovalItem | null = null
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
          const open = chatWorkerDispatches(stop.sessionId, current).filter(({ dispatch }) =>
            seen.has(dispatch.id)
          )
          if (
            stop.reason === 'finished' &&
            open.some(
              ({ dispatch }) => current.getWorkerDispatch(dispatch.id)?.state === 'starting'
            )
          ) {
            setTimer(deliver, AGENT_DONE_QUIET_MS)
            return
          }
          for (const { dispatch, from } of open) {
            const payload =
              approval && stop.promptId
                ? workerApprovalPayload({
                    approvalId: stop.promptId,
                    item: approval,
                    worker: { handle: from, dispatchId: dispatch.id, taskId: dispatch.task_id }
                  })
                : undefined
            reportWorkerTurnStop(
              current,
              { kind: 'local', dispatch },
              {
                from,
                stopKey: stop.stopKey,
                reason: stop.reason,
                lastOutput: status?.lastAssistantMessage,
                ...(stop.waitingOn ? { waitingOn: payload ? 'approval' : stop.waitingOn } : {}),
                ...(payload ? { approval: payload } : {})
              },
              deps
            )
            if (payload && stop.promptId) {
              const tracked = reported.get(stop.sessionId) ?? new Map<string, ReportedApproval>()
              reported.set(stop.sessionId, tracked)
              const entry = tracked.get(stop.promptId) ?? { dispatchIds: new Set<string>() }
              entry.dispatchIds.add(dispatch.id)
              tracked.set(stop.promptId, entry)
            }
          }
        } catch (error) {
          console.warn('[orchestration] chat worker stop report failed', error)
        }
      }
      if (stop.reason === 'finished') {
        setTimer(deliver, AGENT_DONE_QUIET_MS)
      } else if (stop.promptId) {
        // A permission prompt is reported with what it asks; anything else as a plain prompt.
        const promptId = stop.promptId
        void readPrompt(stop.sessionId, promptId)
          .then((prompt) => {
            approval = prompt?.body.resolution.state === 'pending' ? prompt.body : null
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
}
