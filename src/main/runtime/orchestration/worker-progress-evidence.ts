import type { SupervisedWorkerProgressRow } from './types'
import type { WorkerProgressThresholds } from './worker-progress-thresholds'

/** One kind of positive evidence that a supervised worker is still making progress. */
export type WorkerProgressEvidenceKind =
  | 'agent_turn_boundary'
  | 'agent_hook_event'
  | 'terminal_output'
  | 'heartbeat'
  | 'worker_message'
  | 'worker_question'

export const WORKER_PROGRESS_EVIDENCE_KINDS: readonly WorkerProgressEvidenceKind[] = [
  'agent_turn_boundary',
  'agent_hook_event',
  'terminal_output',
  'heartbeat',
  'worker_message',
  'worker_question'
]

/** What this runtime can see of the worker's own pane. Null when it owns no such pane. */
export type WorkerPaneSample = {
  /** False for a pane whose PTY is disconnected — observable identity, unobservable liveness. */
  connected: boolean
  processIncarnation: string | null
  lastOutputAtEpochMs: number | null
  /** Latest harness-reported state for the pane (`working`, `waiting`, `blocked`, `done`). */
  agentState: string | null
  /** When the harness last reported anything at all for the pane. */
  agentEventAtEpochMs: number | null
  /** When the harness last crossed a turn boundary into its current state. */
  agentTurnStartedAtEpochMs: number | null
}

export type WorkerProgressObservation = {
  row: SupervisedWorkerProgressRow
  /** A live `ask` or `check --wait` parked on this dispatch's mailbox. */
  blockingMailboxWait: boolean
  sample: WorkerPaneSample | null
}

export type WorkerProgressStatus = 'working' | 'blocked' | 'unknown' | 'wedged'

export type WorkerProgressReason =
  | 'federated_dispatch'
  | 'awaiting_ask_reply'
  | 'blocking_mailbox_wait'
  | 'agent_awaiting_input'
  | 'worker_pane_unobservable'
  | 'worker_process_replaced'
  | 'worker_process_unverified'
  | 'no_progress_evidence'
  | 'recent_progress_evidence'
  | 'no_progress_within_threshold'

export type WorkerProgressAssessment = {
  dispatchId: string
  runId: string
  taskId: string
  status: WorkerProgressStatus
  reason: WorkerProgressReason
  /** Quiet time measured from the newest evidence, floored at the dispatch start. */
  quietMs: number | null
  lastProgressAtEpochMs: number | null
  observed: WorkerProgressEvidenceKind[]
  absent: WorkerProgressEvidenceKind[]
  agentState: string | null
}

const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

/** SQLite writes UTC without an offset; RPC-exposed rows carry a real ISO string. Accept both. */
export function parseOrchestrationTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const normalized = SQLITE_UTC_TIMESTAMP_RE.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const parsed = Date.parse(normalized)
  return Number.isNaN(parsed) ? null : parsed
}

function collectEvidence(
  observation: WorkerProgressObservation
): Map<WorkerProgressEvidenceKind, number> {
  const { row, sample } = observation
  const evidence = new Map<WorkerProgressEvidenceKind, number>()
  const add = (kind: WorkerProgressEvidenceKind, at: number | null): void => {
    if (at !== null) {
      evidence.set(kind, at)
    }
  }
  add('heartbeat', parseOrchestrationTimestampMs(row.last_heartbeat_at))
  add('worker_message', parseOrchestrationTimestampMs(row.last_worker_message_at))
  add('worker_question', parseOrchestrationTimestampMs(row.last_question_at))
  add('terminal_output', sample?.lastOutputAtEpochMs ?? null)
  add('agent_hook_event', sample?.agentEventAtEpochMs ?? null)
  add('agent_turn_boundary', sample?.agentTurnStartedAtEpochMs ?? null)
  return evidence
}

// Why: a harness that reports `waiting`/`blocked` is parked on input it told us about.
// That is positive evidence of a live process, so it is never a wedge.
const AGENT_AWAITING_INPUT_STATES = new Set(['waiting', 'blocked'])

function assess(
  observation: WorkerProgressObservation,
  evidence: Map<WorkerProgressEvidenceKind, number>,
  args: { nowMs: number; thresholds: WorkerProgressThresholds }
): { status: WorkerProgressStatus; reason: WorkerProgressReason; quietMs: number | null } {
  const { row, sample } = observation
  if (row.federated === 1) {
    // Why: the worker runs on another Orca server, so absent local evidence says
    // nothing about it. Requirement: classify unknown, never escalate.
    return { status: 'unknown', reason: 'federated_dispatch', quietMs: null }
  }
  if (row.pending_question_count > 0) {
    return { status: 'blocked', reason: 'awaiting_ask_reply', quietMs: null }
  }
  if (observation.blockingMailboxWait) {
    return { status: 'blocked', reason: 'blocking_mailbox_wait', quietMs: null }
  }
  if (!sample || !sample.connected) {
    return { status: 'unknown', reason: 'worker_pane_unobservable', quietMs: null }
  }
  // Why before the harness-state check: a pane whose identity we cannot pin to this
  // dispatch tells us nothing about this dispatch — not that it is blocked, not that
  // it is working, and not that it is wedged. An exact match is required whenever the
  // dispatch recorded an identity; a missing live identity is unverified, not a match.
  if (row.process_incarnation && !sample.processIncarnation) {
    return { status: 'unknown', reason: 'worker_process_unverified', quietMs: null }
  }
  if (row.process_incarnation && row.process_incarnation !== sample.processIncarnation) {
    // Why: a different process owns the pane now, so this dispatch's worker is gone.
    // Terminal reconciliation owns that case; a wedge signal would be a wrong diagnosis.
    return { status: 'unknown', reason: 'worker_process_replaced', quietMs: null }
  }
  if (sample.agentState && AGENT_AWAITING_INPUT_STATES.has(sample.agentState)) {
    return { status: 'blocked', reason: 'agent_awaiting_input', quietMs: null }
  }
  if (evidence.size === 0) {
    // Why: no baseline to measure quiet time against. Absence of evidence is
    // unknown, and unknown is never promoted to working either.
    return { status: 'unknown', reason: 'no_progress_evidence', quietMs: null }
  }
  const dispatchedAtMs = parseOrchestrationTimestampMs(row.dispatched_at)
  const newestEvidenceMs = Math.max(...evidence.values())
  const quietMs = args.nowMs - Math.max(newestEvidenceMs, dispatchedAtMs ?? newestEvidenceMs)
  return quietMs < args.thresholds.wedgedAfterMs
    ? { status: 'working', reason: 'recent_progress_evidence', quietMs }
    : { status: 'wedged', reason: 'no_progress_within_threshold', quietMs }
}

/**
 * Classify one supervised worker from its dispatch row plus whatever this runtime
 * can observe. Pure: it reads no clock, touches no process, and returns a signal.
 */
export function classifyWorkerProgress(
  observation: WorkerProgressObservation,
  args: { nowMs: number; thresholds: WorkerProgressThresholds }
): WorkerProgressAssessment {
  const evidence = collectEvidence(observation)
  const verdict = assess(observation, evidence, args)
  const observed = WORKER_PROGRESS_EVIDENCE_KINDS.filter((kind) => evidence.has(kind))
  return {
    dispatchId: observation.row.dispatch_id,
    runId: observation.row.run_id,
    taskId: observation.row.task_id,
    status: verdict.status,
    reason: verdict.reason,
    quietMs: verdict.quietMs,
    lastProgressAtEpochMs: evidence.size > 0 ? Math.max(...evidence.values()) : null,
    observed,
    absent: WORKER_PROGRESS_EVIDENCE_KINDS.filter((kind) => !evidence.has(kind)),
    agentState: observation.sample?.agentState ?? null
  }
}
