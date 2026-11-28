import { createHash } from 'node:crypto'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import type { StructuredAgentSessionRequestFailure } from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import { AgentSessionJournalError } from '../../../../native-chat/agent-session-journal/writing/journal-write-guards'
import { resolveStructuredWorkerIdentityForSession } from '../../terminal-authority/structured-sessions/structured-worker-authority'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import { isSenderOwnRejection } from './chat-worker-error-words'
import { readChatRequestError, unrecordedChatRequestError } from './chat-request-error-read'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { observeWorker } from './worker-presence-report'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'
import { redactFailure } from './worker-turn-stop-wording'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'
import { readChatWorkerUsageLimit } from './chat-worker-usage-limit-read'
import { dispatchReportMailbox } from '../reports/dispatch-report-mailbox'

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

/** The id builds before the presence table gave a failed request's report. */
function escalationId(dispatchId: string, request: StructuredAgentSessionRequestFailure): string {
  return `msg_chaterr_${createHash('sha256')
    .update(JSON.stringify([dispatchId, request.sessionId, request.kind, request.id]))
    .digest('hex')
    .slice(0, 24)}`
}

const REQUEST_FENCE = 'request:'

/** Its worker began another turn, or rested after one, since the failure: other failed requests'
 *  reports aside, that is the newer news. */
function movedOnSince(db: OrchestrationDb, dispatchId: string, seen: number | undefined): boolean {
  const now = readWorkerPresence(db, dispatchId)
  return now !== null && now.generation !== seen && !now.fence?.startsWith(REQUEST_FENCE)
}

/** This Dispatch's latest mail to its coordinator is its usage-limit escalation, and the worker
 *  was sent nothing since: no new work met the limit. */
function lastReportWasUsageLimit(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  from: string
): boolean {
  const row = db.db
    .prepare(
      `SELECT sequence,
         CASE WHEN json_valid(payload) THEN json_extract(payload, '$.failureKind') END AS kind,
         CASE WHEN json_valid(payload) THEN json_extract(payload, '$.dispatchId') END AS dispatch
         FROM messages WHERE to_handle = ? AND from_handle = ? ORDER BY sequence DESC LIMIT 1`
    )
    .get(dispatchReportMailbox(db, dispatch), from)
  if (row?.kind !== 'usageLimitReached' || row.dispatch !== dispatch.id) {
    return false
  }
  const sentSince = db.db
    .prepare('SELECT 1 FROM messages WHERE to_handle = ? AND sequence > ? LIMIT 1')
    .get(`dispatch:${dispatch.id}`, row.sequence)
  return sentSince === undefined
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
    // What the worker did next is the newer fact: a retry it started meanwhile is not stopped.
    const seen = new Map(
      targets.map(({ dispatch }) => [dispatch.id, readWorkerPresence(db, dispatch.id)?.generation])
    )
    const error = await readChatRequestError(request).catch((error: unknown) => {
      if (error instanceof AgentSessionJournalError && error.code === 'journal_closed') {
        return null
      }
      if (!request.death?.rootGone) {
        throw error
      }
      // Committed journal details can be unavailable even though the host proved this exit.
      return unrecordedChatRequestError(request)
    })
    if (!error || isSenderOwnRejection(error)) {
      return
    }
    const { kind } = error
    const text = redactFailure(error.text)
    const detail = error.detail && redactFailure(error.detail)
    const limit =
      kind === 'usageLimitReached' && request.kind === 'turn'
        ? await readChatWorkerUsageLimit(request.sessionId, request.id)
        : null
    for (const { dispatch, from } of targets) {
      // The journal read awaited: the Dispatch may have settled, or the worker moved on.
      const current = db.getDispatchContextById(dispatch.id)
      if (
        (current?.status !== 'pending' && current?.status !== 'dispatched') ||
        current.assignee_handle !== dispatch.assignee_handle ||
        movedOnSince(db, dispatch.id, seen.get(dispatch.id))
      ) {
        continue
      }
      observeWorker(
        db,
        { kind: 'local', dispatch },
        {
          presence: 'at-rest',
          fence: `${REQUEST_FENCE}${request.sessionId}:${request.kind}:${request.id}`,
          legacyStopKey: `request:${request.kind}:${request.id}`,
          legacyReportId: escalationId(dispatch.id, request),
          // The limit was the worker's last news and Orca still continues it: no news. Safe for any
          // turn because coordinator mail waits behind a usage-limited turn (readFailedTurnHold).
          ...(limit?.continues && lastReportWasUsageLimit(db, dispatch, from)
            ? { unreported: true as const }
            : {}),
          rest: {
            from,
            reason: 'errored',
            lastOutput: undefined,
            requestError: {
              text,
              ...(detail ? { detail } : {}),
              ...(kind ? { kind } : {}),
              ...(limit ? { usageLimit: limit } : {}),
              facts: {
                sessionId: request.sessionId,
                agent: request.agent,
                turnOutcome: request.outcome,
                requestId: request.id,
                ...(kind ? { failureKind: kind } : {}),
                error: text,
                ...(detail ? { detail } : {}),
                ...(limit?.resetsAt !== undefined
                  ? { resetsAt: new Date(limit.resetsAt).toISOString() }
                  : {}),
                ...(limit?.continuesAt !== undefined
                  ? { continuesAt: new Date(limit.continuesAt).toISOString() }
                  : {}),
                ...(limit?.continues ? { orcaContinues: true } : {})
              }
            }
          }
        },
        deps
      )
    }
  } catch (error) {
    console.warn('[orchestration] chat worker error escalation failed', request.sessionId, error)
  }
}
