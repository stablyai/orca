import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { dispatchReportMailbox } from '../reports/dispatch-report-mailbox'
import { readCoordinatorMailCount } from '../../db/messages/dispatch-read-mail'
import { rejectedReportInTurn } from '../../db/messages/rejected-worker-report'
import type {
  DispatchContextRow,
  RemoteDispatchAttachmentRow
} from '../../db/orchestration-records'
import { escalateWorkerFailure } from '../reports/worker-failure-escalation'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import type { WorkerApprovalPayload } from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import { describeApprovalClosed } from './worker-approval-text'
import { describeStop, isWorkerGone, WORKER_STOP_SUBJECTS } from './worker-turn-stop-wording'

export type WorkerTurnStopReason = 'finished' | 'errored' | 'needs-input' | 'exited' | 'lost'

export type WorkerTurnStop = {
  /** The worker's own mailbox identity: terminal handle, chat address or structured worker handle. */
  from: string
  /** Identifies this stop; a later turn's stop has a new one, so each stop is reported once. An idle finish is keyed by the coordinator's latest mail instead, and a worker without one goes away only once. */
  stopKey?: string
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

/** Tell the coordinator once that a worker is at rest or gone without reporting; never settles its Dispatch.
 *  True when the report is in the coordinator's mail. */
export function reportWorkerTurnStop(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  stop: WorkerTurnStop,
  deps: WorkerTurnStopReportDeps
): boolean {
  const dispatchId = workerTurnStopDispatchId(target)
  // Going away is never deliberate.
  if (!isWorkerGone(stop.reason) && isDeliberateRest(db, target, stop, deps)) {
    return false
  }
  // An idle finish answers the coordinator's mail the worker took, so it is news once per mail taken: a later
  // idle turn (a worker on its own schedule, or one the user is talking to) repeats what the coordinator was told.
  // One report per approval, whatever else the worker's state does meanwhile.
  const stopKey = stop.approval
    ? `approval:${stop.approval.approvalId}`
    : stop.reason === 'finished'
      ? `finished:${stop.mailTaken ?? readCoordinatorMailCount(db, dispatchId)}`
      : isWorkerGone(stop.reason)
        ? (stop.stopKey ?? 'gone')
        : (stop.stopKey ?? stop.reason)
  return sendWorkerReport(db, target, stop, stopReportId(dispatchId, stopKey), deps)
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
    stopReason: stop.reason,
    ...(stop.approval ? { approval: stop.approval } : {})
  }
  if (target.kind === 'local') {
    const { dispatch } = target
    const woken: [string, string][] = []
    // Stored is sent: a failed wake or an earlier send of this stop still reached the mailbox.
    const sent = runLifecycleWriteTransaction(db.db, 'worker_stop_report', () => {
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
      const inMail = db.getMessageById(id) !== undefined
      if (inMail) {
        stored()
      }
      return inMail
    })
    for (const [handle, type] of woken) {
      deps.notify(handle, type)
    }
    return sent
  }
  // The Run home imports relayed worker mail into the coordinator's Run and wakes it.
  const { attachment } = target
  // A worker_done the home has not acknowledged yet is still a report.
  if (db.hasPendingFederatedWorkerReport(dispatchId)) {
    return false
  }
  // The queued item outlives a crash, and the stable id makes a repeat a no-op here and at the home.
  try {
    db.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'escalation',
      messageId: id,
      payload: JSON.stringify({
        from: stop.from,
        subject,
        body: describeStop(stop, {
          task: attachment.task_id,
          taskId: attachment.task_id,
          dispatchId,
          coordinatorApprovals: deps.coordinatorApprovals?.() === true
        }),
        type: 'escalation',
        priority: 'high',
        threadId: null,
        // Relayed payloads travel as strings, as a worker's own `send` relays them.
        payload: JSON.stringify({ taskId: attachment.task_id, ...payload })
      })
    })
  } catch (error) {
    console.warn('[orchestration] failed to relay a worker stop report', dispatchId, error)
    return false
  }
  stored()
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
