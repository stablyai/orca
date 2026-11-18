import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import { isStructuredWorkerHandle } from '../../../../../shared/orchestration/workers/structured-worker-handle'

const PAGE_ROWS = 50

const activeSweeps = new WeakMap<WorkerTerminalReleaseRuntime, Promise<void>>()

/** Run after a terminal inventory, when an absent process reads as exited rather than not yet found. */
export function sweepStoppedWorkerTerminals(runtime: WorkerTerminalReleaseRuntime): Promise<void> {
  const active = activeSweeps.get(runtime)
  if (active) {
    return active
  }
  const sweep = releaseStoppedWorkerTerminals(runtime)
    .then(
      (released) => {
        if (released > 0) {
          // Counts only; never paths or output.
          console.info('[orchestration] released stopped worker terminals', { released })
        }
      },
      (error: unknown) =>
        console.warn('[orchestration] stopped worker terminal release failed', { error })
    )
    .finally(() => activeSweeps.delete(runtime))
  activeSweeps.set(runtime, sweep)
  return sweep
}

/**
 * Releases stopped or abandoned workers' terminals an older build left owned, so their Run can
 * retire. Only an exact process exit counts; a live or unverifiable process keeps its row.
 */
async function releaseStoppedWorkerTerminals(
  runtime: WorkerTerminalReleaseRuntime
): Promise<number> {
  const db = runtime.getExistingOrchestrationDb()
  if (!db) {
    return 0
  }
  let released = 0
  let structuredHostReady = false
  let after = 0
  for (;;) {
    const page = db.listStoppedWorkerTerminalsStillOwned(after, PAGE_ROWS)
    for (const resource of page) {
      after = resource.row_id
      const processIncarnation = resource.process_incarnation
      if (!processIncarnation) {
        continue
      }
      if (!structuredHostReady && isStructuredWorkerHandle(resource.terminal_handle)) {
        // Structured liveness reads the session host's durable records.
        structuredHostReady = true
        await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      }
      const liveness = await runtime
        .inspectTerminalProcessIncarnationLiveness(processIncarnation, resource.host_scope)
        .catch(() => 'unverifiable' as const)
      if (liveness !== 'exited') {
        continue
      }
      const settled = db.settleDeadWorkerTerminalRelease({
        requestingDispatchId: resource.owner_dispatch_id,
        resourceId: resource.id,
        processIncarnation
      })
      if (settled.disposition === 'released') {
        released += 1
      }
    }
    if (page.length < PAGE_ROWS) {
      return released
    }
  }
}
