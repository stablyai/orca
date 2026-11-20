import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { dispatchReportMailbox } from '../reports/dispatch-report-mailbox'
import { rejectedReportInTurn } from '../../db/messages/rejected-worker-report'
import type {
  DispatchContextRow,
  RemoteDispatchAttachmentRow
} from '../../db/orchestration-records'
import { escalateWorkerFailure } from '../reports/worker-failure-escalation'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import type { WorkerApprovalPayload } from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import { describeApprovalClosed } from './worker-approval-text'
import { describeStop, WORKER_STOP_SUBJECTS } from './worker-turn-stop-wording'

export type WorkerTurnStopReason = 'finished' | 'errored' | 'needs-input' | 'exited' | 'lost'

export type WorkerTurnStop = {
  /** The worker's own mailbox identity: terminal handle, chat address or structured worker handle. */
  from: string
  reason: WorkerTurnStopReason
  /** Coordinator mail the worker had taken when the stop was seen; mail it takes later is its next turn's. */
  mailTaken?: number
  lastOutput: string | undefined
  /** For `needs-input`: the turn ended asking for a reply, which a message answers; else a prompt does. */
  awaitsReply?: boolean
  /** A permission prompt Orca can answer; its id keys the report. */
  approval?: WorkerApprovalPayload
  /** When the stopping turn began, on this host's clock; absent when unknown, which mutes nothing. */
  turnStartedAt?: number
  /** Why the worker went away, for an `exited` or `lost` stop. */
  cause?: string
  /** An exited chat: mail starts it again, keeping its history. */
  restartsOnMail?: true
  /** What the worker left behind, such as the workspace of a start that failed. */
  leftover?: string
  /** A start that never got a terminal has no output to read. */
  neverStarted?: true
  /** How its going away settled the Dispatch; absent while the Dispatch stays open. */
  settled?: 'failed' | 'circuit_broken'
  /** A chat request that failed, reported in the chat's own error words. */
  requestError?: WorkerRequestError
}

export type WorkerRequestError = {
  text: string
  detail?: string
  /** What the coordinator's mail carries about the failed request. */
  facts: Record<string, unknown>
}

export type WorkerTurnStopDispatch =
  | { kind: 'local'; dispatch: DispatchContextRow }
  | { kind: 'remote'; attachment: Pick<RemoteDispatchAttachmentRow, 'dispatch_id' | 'task_id'> }

export type WorkerTurnStopReportDeps = {
  getDb: () => OrchestrationDb | null
  /** `check --wait` holds a `dispatch:<id>` waiter: a deliberate wait. */
  isWaitingForMail: (mailbox: string) => boolean
  notify: (handle: string, messageType: string) => void
  /** Whether a mailbox reaches a chat coordinator, whose user sees the approval card; unknown reads as no. */
  isChatMailbox?: (mailbox: string) => boolean
  /** Whether the user lets coordinator agents allow this machine's workers' prompts; unknown reads as no. */
  coordinatorApprovals?: () => boolean
}

export function workerTurnStopDispatchId(target: WorkerTurnStopDispatch): string {
  return target.kind === 'local' ? target.dispatch.id : target.attachment.dispatch_id
}

/** Waiting on mail, or a clean finish resting on its own question, rejected report or helpers, is deliberate. */
export function isDeliberateRest(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  stop: Pick<WorkerTurnStop, 'reason' | 'turnStartedAt'>,
  deps: Pick<WorkerTurnStopReportDeps, 'isWaitingForMail'>
): boolean {
  const dispatchId = workerTurnStopDispatchId(target)
  return (
    deps.isWaitingForMail(`dispatch:${dispatchId}`) ||
    (stop.reason === 'finished' &&
      (db.awaitsAnswerToLatestQuestion(dispatchId) ||
        rejectedReportInTurn(db, dispatchId, stop.turnStartedAt) ||
        (target.kind === 'local' && db.hasOpenHelperDispatch(dispatchId))))
  )
}

/** Writes a stop report under `id`; `stored` runs in the same transaction as a local report's mail.
 *  True when the report is in the coordinator's mail, or queued for its Run home. */
export function sendWorkerReport(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  stop: WorkerTurnStop,
  id: string,
  deps: WorkerTurnStopReportDeps,
  stored: () => void = () => {}
): boolean {
  const dispatchId = workerTurnStopDispatchId(target)
  const subject = stop.approval
    ? 'Worker is waiting for permission'
    : WORKER_STOP_SUBJECTS[stop.reason]
  const payload = {
    dispatchId,
    handle: stop.from,
    ...(stop.requestError ? stop.requestError.facts : { stopReason: stop.reason }),
    ...(stop.approval ? { approval: stop.approval } : {})
  }
  // A worker_done its Run home has not acknowledged yet is still a report.
  if (target.kind === 'remote' && db.hasPendingFederatedWorkerReport(dispatchId)) {
    return false
  }
  const woken: [string, string][] = []
  let sent: boolean
  try {
    // The report and the record of having sent it commit together.
    sent = runLifecycleWriteTransaction(db.db, 'worker_stop_report', () => {
      const inMail =
        target.kind === 'local'
          ? mailWorkerReport(db, target.dispatch, stop, { id, subject, payload }, deps, woken)
          : relayWorkerReport(db, target.attachment, stop, { id, subject, payload }, deps)
      if (inMail) {
        stored()
      }
      return inMail
    })
  } catch (error) {
    console.warn('[orchestration] failed to send a worker stop report', dispatchId, error)
    return false
  }
  // Committed is sent: a wake that fails does not unsend it.
  for (const [handle, type] of woken) {
    try {
      deps.notify(handle, type)
    } catch (error) {
      console.warn('[orchestration] waking for a worker stop report failed', handle, error)
    }
  }
  return sent
}

type WorkerReportMail = { id: string; subject: string; payload: Record<string, unknown> }

/** Stored is sent: a failed wake or an earlier send of this stop still reached the mailbox. */
function mailWorkerReport(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  stop: WorkerTurnStop,
  { id, subject, payload }: WorkerReportMail,
  deps: WorkerTurnStopReportDeps,
  woken: [string, string][]
): boolean {
  escalateWorkerFailure(
    db,
    dispatch,
    {
      id,
      from: stop.from,
      mailbox: () => dispatchReportMailbox(db, dispatch),
      describe: (task) => ({
        subject,
        body: describeStop(stop, {
          task,
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          chatCoordinator: deps.isChatMailbox?.(dispatchReportMailbox(db, dispatch)) === true,
          taskReady: db.getTask(dispatch.task_id)?.status === 'ready',
          coordinatorApprovals: deps.coordinatorApprovals?.() === true
        })
      }),
      payload: { taskId: dispatch.task_id, ...payload }
    },
    (handle, type) => woken.push([handle, type])
  )
  return db.getMessageById(id) !== undefined
}

/** The Run home imports relayed worker mail into the coordinator's Run and wakes it. The queued
 *  item outlives a crash, and the stable id makes a repeat a no-op here and at the home. */
function relayWorkerReport(
  db: OrchestrationDb,
  attachment: Pick<RemoteDispatchAttachmentRow, 'dispatch_id' | 'task_id'>,
  stop: WorkerTurnStop,
  { id, subject, payload }: WorkerReportMail,
  deps: WorkerTurnStopReportDeps
): true {
  db.enqueueFederationRelay({
    dispatchId: attachment.dispatch_id,
    direction: 'to_home',
    kind: 'escalation',
    messageId: id,
    payload: JSON.stringify({
      from: stop.from,
      subject,
      body: describeStop(stop, {
        task: attachment.task_id,
        taskId: attachment.task_id,
        dispatchId: attachment.dispatch_id,
        coordinatorApprovals: deps.coordinatorApprovals?.() === true
      }),
      type: 'escalation',
      priority: 'high',
      threadId: null,
      // Relayed payloads travel as strings, as a worker's own `send` relays them.
      payload: JSON.stringify({ taskId: attachment.task_id, ...payload })
    })
  })
  return true
}

/** A stable message id: writing the same report twice is a no-op. */
export function stopReportId(dispatchId: string, stopKey: string): string {
  return `msg_stop_${createHash('sha256')
    .update(JSON.stringify([dispatchId, stopKey]))
    .digest('hex')
    .slice(0, 24)}`
}

/** The one closing line for a reported approval; the same stable id makes a second closer a no-op. */
export function reportWorkerApprovalClosed(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  closed: { from: string; approval: WorkerApprovalPayload },
  deps: Pick<WorkerTurnStopReportDeps, 'notify'>,
  /** Names how an already-closed prompt closed: its card's receipt changes, the coordinator is not woken. */
  refines = false
): void {
  const { approval } = closed
  const status = db.getDispatchContextById(dispatch.id)?.status
  // Unanswered, and its worker already ended: the card reads that on its own, and the coordinator
  // was told the worker ended; a second notice adds nothing.
  if (!approval.outcome?.decision && status !== 'pending' && status !== 'dispatched') {
    return
  }
  escalateWorkerFailure(
    db,
    dispatch,
    {
      id: stopReportId(
        dispatch.id,
        `approval:${approval.approvalId}:${refines ? 'refined' : 'closed'}`
      ),
      from: closed.from,
      mailbox: () => dispatchReportMailbox(db, dispatch),
      describe: () => ({
        subject: approval.outcome?.decision ? 'Worker approval answered' : 'Worker approval closed',
        body: describeApprovalClosed(approval)
      }),
      payload: { taskId: dispatch.task_id, dispatchId: dispatch.id, handle: closed.from, approval },
      // Only a person at the worker's terminal can answer it now: that needs the coordinator to act.
      ...(approval.outcome?.by === 'terminal-only' ? {} : { notice: true as const })
    },
    refines ? () => {} : deps.notify
  )
}
