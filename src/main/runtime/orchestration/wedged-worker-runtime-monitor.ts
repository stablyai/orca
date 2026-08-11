import type { OrcaRuntimeService } from '../orca-runtime'
import {
  WedgedWorkerDetector,
  type WedgedWorkerObservationSource,
  type WedgedWorkerScanSummary
} from './wedged-worker-detector'
import { resolveWorkerProgressThresholds } from './worker-progress-thresholds'

type MonitorState = {
  detector: WedgedWorkerDetector
  timer: ReturnType<typeof setInterval>
  consecutiveFailures: number
}

// Why a bound rather than a single strike: a transient DB error must not end detection
// for every worker under supervision, but a durably broken DB should not be retried
// forever either. A later worker start re-arms the monitor in both cases.
const MAX_CONSECUTIVE_SCAN_FAILURES = 5

const monitorByRuntime = new WeakMap<OrcaRuntimeService, MonitorState>()

function createObservationSource(runtime: OrcaRuntimeService): WedgedWorkerObservationSource {
  return {
    samplePane: (paneKey) => (paneKey ? runtime.getOrchestrationWorkerPaneActivity(paneKey) : null),
    hasBlockingMailboxWait: (dispatchId) =>
      runtime.hasOrchestrationMailboxWaiter(`dispatch:${dispatchId}`)
  }
}

function createDetector(runtime: OrcaRuntimeService): WedgedWorkerDetector {
  return new WedgedWorkerDetector({
    db: runtime.getOrchestrationDb(),
    source: createObservationSource(runtime),
    thresholds: resolveWorkerProgressThresholds(),
    // Why the Run mailbox: the signal belongs to whoever supervises this Dispatch,
    // and `from: dispatch:<id>` keeps it attributable without claiming worker authority.
    emit: ({ assessment, message }) => {
      const inserted = runtime.getOrchestrationDb().insertMessage({
        runId: assessment.runId,
        from: `dispatch:${assessment.dispatchId}`,
        to: `run:${assessment.runId}`,
        subject: message.subject,
        body: message.body,
        type: 'escalation',
        priority: 'high',
        payload: message.payload
      })
      runtime.notifyMessageArrived(inserted.to_handle, inserted.type)
    },
    onLog: (line) => console.info(`[orchestration] ${line}`)
  })
}

/**
 * Arm the wedged-worker detector for this runtime. Idempotent, and cheap when no
 * supervised workers exist: the first scan that finds no `ready` dispatch stops the
 * timer again, and a later worker start re-arms it.
 */
export function ensureWedgedWorkerMonitor(runtime: OrcaRuntimeService): void {
  if (monitorByRuntime.has(runtime)) {
    return
  }
  let detector: WedgedWorkerDetector
  try {
    detector = createDetector(runtime)
  } catch (error) {
    console.warn('[orchestration] wedged-worker detector unavailable', { error })
    return
  }
  if (!detector.getThresholds().enabled) {
    return
  }
  const timer = setInterval(() => {
    runWedgedWorkerScan(runtime)
  }, detector.getThresholds().scanIntervalMs)
  // Why unref: a detection-only timer must never hold the process open.
  timer.unref?.()
  monitorByRuntime.set(runtime, { detector, timer, consecutiveFailures: 0 })
}

export function stopWedgedWorkerMonitor(runtime: OrcaRuntimeService): void {
  const state = monitorByRuntime.get(runtime)
  if (!state) {
    return
  }
  clearInterval(state.timer)
  monitorByRuntime.delete(runtime)
}

/** One scan pass. Exported so a caller (or a test) can drive the detector directly. */
export function runWedgedWorkerScan(runtime: OrcaRuntimeService): WedgedWorkerScanSummary | null {
  const state = monitorByRuntime.get(runtime)
  if (!state) {
    return null
  }
  try {
    const summary = state.detector.scanOnce()
    state.consecutiveFailures = 0
    if (summary.candidates === 0) {
      stopWedgedWorkerMonitor(runtime)
    }
    return summary
  } catch (error) {
    // Why keep the timer: this is an advisory signal, so a scan failure must never
    // surface as a worker-facing error — but it must not disarm detection for every
    // worker under supervision either. The next tick retries.
    state.consecutiveFailures += 1
    console.warn('[orchestration] wedged-worker scan failed', {
      error,
      consecutiveFailures: state.consecutiveFailures
    })
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_SCAN_FAILURES) {
      console.warn('[orchestration] wedged-worker detection disarmed after repeated failures')
      stopWedgedWorkerMonitor(runtime)
    }
    return null
  }
}
