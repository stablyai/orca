import type { MessageRow } from './types'
import type {
  WorkerProgressAssessment,
  WorkerProgressEvidenceKind
} from './worker-progress-evidence'
import { parseOrchestrationTimestampMs } from './worker-progress-evidence'
import type { WorkerProgressThresholds } from './worker-progress-thresholds'

/** Marks an escalation this detector synthesized, so a rescan can resume its count. */
export const WEDGED_WORKER_SIGNAL_KIND = 'wedged_worker_signal'

export type WedgedWorkerEscalationRecord = {
  escalationCount: number
  escalatedAtEpochMs: number
  /** True when the instant came from the row stamp, which keeps whole seconds only. */
  escalatedAtIsTruncated: boolean
}

export type WedgedWorkerEscalationPlan =
  | { escalate: false }
  | { escalate: true; escalationCount: number }

/**
 * Decide whether an unchanged wedge earns another escalation. The first wedge
 * escalates once; every repeat waits a full `reEscalateAfterMs` and carries a
 * higher count, so a short scan interval never turns into inbox spam.
 */
export function planWedgedWorkerEscalation(args: {
  assessment: WorkerProgressAssessment
  previous: WedgedWorkerEscalationRecord | undefined
  nowMs: number
  thresholds: WorkerProgressThresholds
}): WedgedWorkerEscalationPlan {
  if (args.assessment.status !== 'wedged') {
    return { escalate: false }
  }
  if (!args.previous) {
    return { escalate: true, escalationCount: 1 }
  }
  const elapsed = args.nowMs - args.previous.escalatedAtEpochMs
  return elapsed >= args.thresholds.reEscalateAfterMs
    ? { escalate: true, escalationCount: args.previous.escalationCount + 1 }
    : { escalate: false }
}

type WedgedWorkerSignalPayload = {
  kind: typeof WEDGED_WORKER_SIGNAL_KIND
  wedgedWorker: {
    dispatchId: string
    runId: string
    // Why nested, never top level: the retired coordinator loop reads a top-level
    // payload.taskId on any escalation and fails the dispatch. This signal must
    // never cause an effect, so it stays outside that shape.
    taskId: string
    escalationCount: number
    /** The exact instant the detector escalated, so a restart never reads a rounded one. */
    escalatedAtEpochMs: number
    quietMs: number | null
    lastProgressAt: string | null
    observed: WorkerProgressEvidenceKind[]
    absent: WorkerProgressEvidenceKind[]
    agentState: string | null
    thresholdMs: number
    reEscalateAfterMs: number
    detectionOnly: true
  }
}

// Why a tolerance: an escalation read back off the row stamp carries SQLite's
// `datetime('now')`, which truncates to whole seconds, while pane evidence carries
// millisecond precision. Without this margin a truncated stamp reads as "progress
// happened after the escalation" and the same unchanged wedge escalates twice. It
// applies to that stamp alone — an exact instant needs no margin, and giving it one
// would swallow real progress made inside the second after the escalation.
const PERSISTED_ESCALATION_TRUNCATION_MS = 1_000

/**
 * True when the worker made progress after this escalation was sent, which makes a later
 * wedge a new one rather than a repeat. Its count restarts and its cadence does not
 * suppress it.
 */
export function isEscalationSupersededByProgress(
  record: WedgedWorkerEscalationRecord,
  lastProgressAtEpochMs: number | null
): boolean {
  const tolerance = record.escalatedAtIsTruncated ? PERSISTED_ESCALATION_TRUNCATION_MS : 0
  return (
    lastProgressAtEpochMs !== null && lastProgressAtEpochMs > record.escalatedAtEpochMs + tolerance
  )
}

/** Read the count back off a previously synthesized escalation so restarts stay monotonic. */
export function readWedgedWorkerEscalationRecord(
  message: MessageRow | undefined
): WedgedWorkerEscalationRecord | undefined {
  if (!message?.payload) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(message.payload)
  } catch {
    return undefined
  }
  const record = parsed as Partial<WedgedWorkerSignalPayload>
  const count = record?.wedgedWorker?.escalationCount
  if (record?.kind !== WEDGED_WORKER_SIGNAL_KIND || typeof count !== 'number' || count < 1) {
    return undefined
  }
  const escalationCount = Math.trunc(count)
  // Why prefer the payload: it holds the exact instant the detector escalated. The row
  // stamp is the fallback for records written before the field existed, and it keeps
  // whole seconds only, so it is marked as such.
  const exact = record.wedgedWorker?.escalatedAtEpochMs
  if (typeof exact === 'number' && Number.isFinite(exact)) {
    return { escalationCount, escalatedAtEpochMs: exact, escalatedAtIsTruncated: false }
  }
  const stampedAtEpochMs = parseOrchestrationTimestampMs(message.created_at)
  return stampedAtEpochMs === null
    ? undefined
    : { escalationCount, escalatedAtEpochMs: stampedAtEpochMs, escalatedAtIsTruncated: true }
}

function formatMinutes(ms: number | null): string {
  return ms === null ? 'unknown' : `${Math.max(1, Math.round(ms / 60_000))} min`
}

function formatEvidenceList(kinds: WorkerProgressEvidenceKind[]): string {
  return kinds.length > 0 ? kinds.join(', ') : 'none'
}

export type WedgedWorkerEscalationMessage = {
  subject: string
  body: string
  payload: string
}

export function buildWedgedWorkerEscalation(args: {
  assessment: WorkerProgressAssessment
  escalationCount: number
  /** The instant the detector escalated, recorded exactly so a restart reads it back unrounded. */
  escalatedAtEpochMs: number
  thresholds: WorkerProgressThresholds
}): WedgedWorkerEscalationMessage {
  const { assessment, escalationCount, escalatedAtEpochMs, thresholds } = args
  const quiet = formatMinutes(assessment.quietMs)
  const lastProgressAt =
    assessment.lastProgressAtEpochMs === null
      ? null
      : new Date(assessment.lastProgressAtEpochMs).toISOString()
  const payload: WedgedWorkerSignalPayload = {
    kind: WEDGED_WORKER_SIGNAL_KIND,
    wedgedWorker: {
      dispatchId: assessment.dispatchId,
      runId: assessment.runId,
      taskId: assessment.taskId,
      escalationCount,
      escalatedAtEpochMs,
      quietMs: assessment.quietMs,
      lastProgressAt,
      observed: assessment.observed,
      absent: assessment.absent,
      agentState: assessment.agentState,
      thresholdMs: thresholds.wedgedAfterMs,
      reEscalateAfterMs: thresholds.reEscalateAfterMs,
      detectionOnly: true
    }
  }
  const body = [
    `Worker dispatch ${assessment.dispatchId} on task ${assessment.taskId} has shown no sign of progress for ${quiet}.`,
    '',
    `Observed progress evidence: ${formatEvidenceList(assessment.observed)}.`,
    `Not observed: ${formatEvidenceList(assessment.absent)}.`,
    `Last progress evidence: ${lastProgressAt ?? 'none recorded'}.`,
    `Harness state: ${assessment.agentState ?? 'not reported'}.`,
    `Threshold: ${formatMinutes(thresholds.wedgedAfterMs)}. Escalation ${escalationCount}; the next one comes no sooner than ${formatMinutes(thresholds.reEscalateAfterMs)} from now, and only if nothing changes.`,
    '',
    'This is a detection signal only. Orca has not stopped, interrupted, restarted, focused or written to this worker, and it will not.',
    'A `check --wait` timeout is still a checkpoint rather than a failure. Read the worker before you decide anything:',
    `  orca orchestration worker-show --dispatch ${assessment.dispatchId} --json`,
    `  orca orchestration worker-read --dispatch ${assessment.dispatchId} --limit 50 --json`
  ].join('\n')
  return {
    subject: `Worker ${assessment.dispatchId} may be wedged (no progress for ${quiet})`,
    body,
    payload: JSON.stringify(payload)
  }
}
