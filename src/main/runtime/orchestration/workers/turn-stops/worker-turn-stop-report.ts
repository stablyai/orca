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
import type { AgentBackgroundWait } from '../../../../../shared/agent-status/lifecycle/agent-background-wait'
import { workerBackgroundWaitDueAt } from './worker-background-wait-notice'
import type { UnconfirmedStartEvidence } from './unconfirmed-start-evidence'

export type WorkerTurnStopReason =
  | 'finished'
  | 'errored'
  | 'needs-input'
  | 'exited'
  | 'lost'
  | 'start-unconfirmed'
  | 'start-blocked'
  | 'never-ready'
  /** The start failed before its worker ran, so nothing of it was lost. */
  | 'start-failed'
  /** The turn ended while background tasks the worker started still run: news only once it outlasts the bound. */
  | 'background-wait'

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
  /** Why the worker went away, for an `exited`, `lost` or `start-failed` stop. */
  cause?: string
  /** An exited chat: mail starts it again, keeping its history. */
  restartsOnMail?: true
  /** What the worker left behind, such as the workspace of a start that failed. */
  leftover?: string
  /** A start that never got a terminal has no output to read. */
  neverStarted?: true
  /** For `start-blocked`: the screen a person must answer, and when the start fails if its agent
   *  is still not ready. */
  blockedStart?: { screen: string; readyBy: number }
  /** For `start-unconfirmed`: where the brief waits, which decides how to check it. */
  startSurface?: 'terminal' | 'chat'
  /** For `start-unconfirmed`: when the brief and its Enter went in, and what the terminal showed since. */
  startEvidence?: UnconfirmedStartEvidence
  /** How its going away settled the Dispatch; absent while the Dispatch stays open. */
  settled?: 'failed' | 'circuit_broken'
  /** A chat request that failed, reported in the chat's own error words. */
  requestError?: WorkerRequestError
  /** For `background-wait`: when the turn ended, what its background tasks run, and the pane whose
   *  row showed it (absent on a paired server's relayed copy). */
  backgroundWait?: AgentBackgroundWait & { paneKey?: string; chat?: true }
}

/** What the report of a rest, as opposed to a worker gone, carries. */
export type WorkerRestFact =
  | 'from'
  | 'lastOutput'
  | 'awaitsReply'
  | 'approval'
  | 'turnStartedAt'
  | 'mailTaken'
  | 'requestError'
  | 'startSurface'
  | 'startEvidence'
  | 'blockedStart'
  | 'backgroundWait'

export type WorkerRequestError = {
  text: string
  detail?: string
  /** The shared failure kind, when the failure was typed. */
  kind?: string
  /** A terminal's failure, held back like its other rests while it waits for mail; a chat's is not. */
  heldByWaits?: true
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
  /** A chat whose turn ended while its own background tasks run: its background waits own that rest. */
  chatWaitsOnBackground?: (sessionId: string) => boolean
  /** Whether a recorded background wait's pane still shows it; unknown reads as yes. */
  backgroundWaitShown?: (wait: { since: number; paneKey?: string; chat?: true }) => boolean
}

export function workerTurnStopDispatchId(target: WorkerTurnStopDispatch): string {
  return target.kind === 'local' ? target.dispatch.id : target.attachment.dispatch_id
}

/** Waiting on mail, or a clean finish resting on its own question, rejected report or helpers, is deliberate.
 *  So is waiting on its own background task, until the wait outlasts the bound. A failed request a chat showed never is. */
export function isDeliberateRest(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  stop: Pick<WorkerTurnStop, 'reason' | 'turnStartedAt' | 'requestError' | 'backgroundWait'>,
  deps: Pick<WorkerTurnStopReportDeps, 'isWaitingForMail' | 'backgroundWaitShown'>
): boolean {
  const dispatchId = workerTurnStopDispatchId(target)
  if (stop.requestError && !stop.requestError.heldByWaits) {
    return false
  }
  // Held until its bound; a wait its pane no longer shows waits for its timer to settle it unsent.
  const wait = stop.reason === 'background-wait' ? stop.backgroundWait : undefined
  if (
    wait &&
    (Date.now() < workerBackgroundWaitDueAt(wait.since) ||
      deps.backgroundWaitShown?.(wait) === false)
  ) {
    return true
  }
  // Past its bound, a background wait is still deliberate for every reason a clean finish is.
  return (
    deps.isWaitingForMail(`dispatch:${dispatchId}`) ||
    ((stop.reason === 'finished' || stop.reason === 'background-wait') &&
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
    : stop.requestError?.kind === 'usageLimitReached'
      ? 'Worker hit its usage limit'
      : stop.startEvidence?.continuePrompt
        ? "Worker's continue prompt may not have been submitted"
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

export type WorkerReportMail = { id: string; subject: string; payload: Record<string, unknown> }

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
  const body = describeStop(stop, {
    task: attachment.task_id,
    taskId: attachment.task_id,
    dispatchId: attachment.dispatch_id,
    coordinatorApprovals: deps.coordinatorApprovals?.() === true
  })
  return relayWorkerMail(db, attachment, { id, from: stop.from, subject, body, payload })
}

/** Queues worker mail for its Run home, which imports it into the coordinator's Run and wakes it. */
export function relayWorkerMail(
  db: OrchestrationDb,
  attachment: Pick<RemoteDispatchAttachmentRow, 'dispatch_id' | 'task_id'>,
  mail: WorkerReportMail & { from: string; body: string; notice?: true }
): true {
  db.enqueueFederationRelay({
    dispatchId: attachment.dispatch_id,
    direction: 'to_home',
    kind: 'escalation',
    messageId: mail.id,
    payload: JSON.stringify({
      from: mail.from,
      subject: mail.subject,
      body: mail.body,
      type: mail.notice ? 'status' : 'escalation',
      priority: mail.notice ? 'normal' : 'high',
      threadId: null,
      // Relayed payloads travel as strings, as a worker's own `send` relays them.
      payload: JSON.stringify({ taskId: attachment.task_id, ...mail.payload })
    })
  })
  return true
}

const FAILED_LEAD_FENCE_PREFIX = 'failed-lead:'

/** Names a lead turn that failed under live children by its end: a restart that remints the process id,
 *  a prompt in between, or the later all-clear is the same failure, under one stable report id. */
export function failedLeadTurnFence(since: number): string {
  return `${FAILED_LEAD_FENCE_PREFIX}${since}`
}

export function isFailedLeadTurnFence(fence: string | null): fence is string {
  return fence?.startsWith(FAILED_LEAD_FENCE_PREFIX) === true
}

/** A stable message id: writing the same report twice is a no-op. */
export function stopReportId(dispatchId: string, stopKey: string): string {
  return `msg_stop_${createHash('sha256')
    .update(JSON.stringify([dispatchId, stopKey]))
    .digest('hex')
    .slice(0, 24)}`
}

/** One stable id per rest: writing it twice, here or at a Run home, is a no-op. */
export function presenceReportId(dispatchId: string, generation: number): string {
  return `msg_rest_${createHash('sha256')
    .update(JSON.stringify([dispatchId, generation]))
    .digest('hex')
    .slice(0, 24)}`
}

/** Approvals open and close on their own, so each keeps one report whatever the worker does meanwhile. */
export function approvalReportId(dispatchId: string, approvalId: string): string {
  return stopReportId(dispatchId, `approval:${approvalId}`)
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
