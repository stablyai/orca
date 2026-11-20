import { createHash } from 'node:crypto'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import type { StructuredAgentSessionRequestFailure } from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import { resolveStructuredWorkerIdentityForSession } from '../../terminal-authority/structured-sessions/structured-worker-authority'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import { isSenderOwnRejection } from './chat-worker-error-words'
import { readChatRequestError } from './chat-request-error-read'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { escalateWorkerFailure } from '../reports/worker-failure-escalation'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'

type ChatWorkerDispatch = { dispatch: DispatchContextRow; from: string }

/** The open Dispatch this session works, as a chat assignee or as a structured worker. */
export function chatWorkerDispatches(sessionId: string, db: OrchestrationDb): ChatWorkerDispatch[] {
  const found: ChatWorkerDispatch[] = []
  if (isOrcaSessionId(sessionId)) {
    // A `/clear` successor keeps its root's address, so the Dispatch names the root.
    const address = formatOrcaSessionAddress(canonicalOrcaSessionId(sessionId))
    const dispatch = db.getActiveDispatchForTerminal(address)
    if (dispatch) {
      found.push({ dispatch, from: address })
    }
  }
  const worker = resolveStructuredWorkerIdentityForSession(sessionId, db)
  const dispatch = worker && db.getActiveDispatchForTerminal(worker.handle, worker.paneKey)
  if (worker && dispatch && !found.some((entry) => entry.dispatch.id === dispatch.id)) {
    found.push({ dispatch, from: worker.handle })
  }
  return found
}

function escalationId(dispatchId: string, request: StructuredAgentSessionRequestFailure): string {
  return `msg_chaterr_${createHash('sha256')
    .update(JSON.stringify([dispatchId, request.sessionId, request.kind, request.id]))
    .digest('hex')
    .slice(0, 24)}`
}

/** Capture authority synchronously; notification bookkeeping never rejects a committed write. */
export async function escalateChatWorkerError(
  request: StructuredAgentSessionRequestFailure,
  deps: WorkerTurnStopReportDeps
): Promise<void> {
  try {
    const db = deps.getDb()
    const targets = db ? chatWorkerDispatches(request.sessionId, db) : []
    if (!db || targets.length === 0) {
      return
    }
    const error = await readChatRequestError(request)
    if (!error || isSenderOwnRejection(error)) {
      return
    }
    const { text, detail, kind } = error
    for (const { dispatch, from } of targets) {
      // The journal read awaited: the Dispatch may have settled.
      const current = db.getDispatchContextById(dispatch.id)
      if (
        (current?.status !== 'pending' && current?.status !== 'dispatched') ||
        current.assignee_handle !== dispatch.assignee_handle
      ) {
        continue
      }
      escalateWorkerFailure(
        db,
        dispatch,
        {
          id: escalationId(dispatch.id, request),
          from,
          describe: (task) => ({
            subject: `Agent hit an error: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`,
            body: [
              `Worker ${from} hit an error while running task ${task}.`,
              `Error: ${text}`,
              ...(detail ? [`Details from the agent: ${detail}`] : []),
              'The task is still assigned to this chat, which keeps its history.'
            ].join('\n')
          }),
          payload: {
            taskId: dispatch.task_id,
            dispatchId: dispatch.id,
            handle: from,
            sessionId: request.sessionId,
            agent: request.agent,
            turnOutcome: request.outcome,
            requestId: request.id,
            ...(kind ? { failureKind: kind } : {}),
            error: text,
            ...(detail ? { detail } : {})
          }
        },
        deps.notify
      )
    }
  } catch (error) {
    console.warn('[orchestration] chat worker error escalation failed', request.sessionId, error)
  }
}
