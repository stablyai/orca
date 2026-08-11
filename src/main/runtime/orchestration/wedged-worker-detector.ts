import type { OrchestrationDb } from './db'
import type { SupervisedWorkerProgressRow } from './types'
import {
  buildWedgedWorkerEscalation,
  planWedgedWorkerEscalation,
  readWedgedWorkerEscalationRecord,
  type WedgedWorkerEscalationMessage,
  type WedgedWorkerEscalationRecord
} from './wedged-worker-escalation'
import {
  classifyWorkerProgress,
  type WorkerPaneSample,
  type WorkerProgressAssessment
} from './worker-progress-evidence'
import {
  resolveWorkerProgressThresholds,
  type WorkerProgressThresholds
} from './worker-progress-thresholds'

/** Everything the detector needs from the live runtime, kept injectable for tests. */
export type WedgedWorkerObservationSource = {
  /** Pane liveness for a dispatch's assignee pane; null when this runtime owns no such pane. */
  samplePane(paneKey: string | null): WorkerPaneSample | null
  /** True while an `ask` or `check --wait` is parked on this dispatch's mailbox. */
  hasBlockingMailboxWait(dispatchId: string): boolean
}

export type WedgedWorkerEscalationEmitter = (args: {
  assessment: WorkerProgressAssessment
  escalationCount: number
  message: WedgedWorkerEscalationMessage
}) => void

export type WedgedWorkerScanSummary = {
  candidates: number
  escalated: number
  byStatus: Record<WorkerProgressAssessment['status'], number>
}

export type WedgedWorkerDetectorOptions = {
  db: OrchestrationDb
  source: WedgedWorkerObservationSource
  emit: WedgedWorkerEscalationEmitter
  thresholds?: WorkerProgressThresholds
  now?: () => number
  onLog?: (message: string) => void
}

/**
 * Watches supervised worker dispatches for a total absence of progress evidence and
 * reports it. It performs no process, terminal or filesystem action of any kind: the
 * only effect it can have is one `escalation` message in the owning Run's mailbox.
 */
export class WedgedWorkerDetector {
  private readonly escalations = new Map<string, WedgedWorkerEscalationRecord>()
  private readonly thresholds: WorkerProgressThresholds
  private readonly now: () => number

  constructor(private readonly options: WedgedWorkerDetectorOptions) {
    this.thresholds = options.thresholds ?? resolveWorkerProgressThresholds()
    this.now = options.now ?? (() => Date.now())
  }

  getThresholds(): WorkerProgressThresholds {
    return this.thresholds
  }

  scanOnce(): WedgedWorkerScanSummary {
    const summary: WedgedWorkerScanSummary = {
      candidates: 0,
      escalated: 0,
      byStatus: { working: 0, blocked: 0, unknown: 0, wedged: 0 }
    }
    if (!this.thresholds.enabled) {
      return summary
    }
    const rows = this.options.db.listSupervisedWorkerProgressRows()
    summary.candidates = rows.length
    // Why: a dispatch that settled between scans keeps no cadence state — a later
    // retry of the same task gets a fresh dispatch id anyway.
    this.forgetSettledDispatches(rows)
    const nowMs = this.now()
    for (const row of rows) {
      const assessment = this.assessRow(row, nowMs)
      summary.byStatus[assessment.status] += 1
      if (this.maybeEscalate(assessment, nowMs)) {
        summary.escalated += 1
      }
    }
    return summary
  }

  private assessRow(row: SupervisedWorkerProgressRow, nowMs: number): WorkerProgressAssessment {
    return classifyWorkerProgress(
      {
        row,
        blockingMailboxWait: this.options.source.hasBlockingMailboxWait(row.dispatch_id),
        sample: this.options.source.samplePane(row.assignee_pane_key)
      },
      { nowMs, thresholds: this.thresholds }
    )
  }

  private maybeEscalate(assessment: WorkerProgressAssessment, nowMs: number): boolean {
    if (assessment.status !== 'wedged') {
      // Why: resumed progress clears the cadence, so a later wedge reads as a new one.
      this.escalations.delete(assessment.dispatchId)
      return false
    }
    const plan = planWedgedWorkerEscalation({
      assessment,
      previous: this.recallEscalation(assessment.dispatchId),
      nowMs,
      thresholds: this.thresholds
    })
    if (!plan.escalate) {
      return false
    }
    const message = buildWedgedWorkerEscalation({
      assessment,
      escalationCount: plan.escalationCount,
      thresholds: this.thresholds
    })
    this.escalations.set(assessment.dispatchId, {
      escalationCount: plan.escalationCount,
      escalatedAtEpochMs: nowMs
    })
    this.options.emit({ assessment, escalationCount: plan.escalationCount, message })
    this.options.onLog?.(
      `Wedged-worker signal ${plan.escalationCount} for dispatch ${assessment.dispatchId} (quiet ${assessment.quietMs ?? 0} ms)`
    )
    return true
  }

  // Why read the DB: a runtime restart loses in-memory cadence state, and an
  // already-escalated wedge must not restart its count on the next scan.
  private recallEscalation(dispatchId: string): WedgedWorkerEscalationRecord | undefined {
    const remembered = this.escalations.get(dispatchId)
    if (remembered) {
      return remembered
    }
    const persisted = readWedgedWorkerEscalationRecord(
      this.options.db.getLatestDispatchEscalation(dispatchId)
    )
    if (persisted) {
      this.escalations.set(dispatchId, persisted)
    }
    return persisted
  }

  private forgetSettledDispatches(rows: SupervisedWorkerProgressRow[]): void {
    if (this.escalations.size === 0) {
      return
    }
    const live = new Set(rows.map((row) => row.dispatch_id))
    for (const dispatchId of this.escalations.keys()) {
      if (!live.has(dispatchId)) {
        this.escalations.delete(dispatchId)
      }
    }
  }
}
