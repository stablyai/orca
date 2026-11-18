import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import type { PtyProcessInfo } from '../../../../providers/pty/process-info'
import { isStructuredWorkerHandle } from '../../../../../shared/orchestration/workers/structured-worker-handle'

const PAGE_ROWS = 50

const activeSweeps = new WeakMap<WorkerTerminalReleaseRuntime, Promise<void>>()

/** Run after a terminal inventory, when an absent process reads as exited rather than not yet found. */
export function sweepStoppedWorkerTerminals(
  runtime: WorkerTerminalReleaseRuntime,
  stopped: () => boolean
): Promise<void> {
  const active = activeSweeps.get(runtime)
  if (active) {
    return active
  }
  const sweep = releaseExitedWorkerTerminals(runtime, stopped)
    .then(
      (released) => {
        if (released > 0) {
          // Counts only; never paths or output.
          console.info('[orchestration] released exited worker terminals', { released })
        }
      },
      (error: unknown) =>
        console.warn('[orchestration] exited worker terminal release failed', { error })
    )
    .finally(() => activeSweeps.delete(runtime))
  activeSweeps.set(runtime, sweep)
  return sweep
}

/**
 * Releases settled workers' terminals that are still owned and never requested, as older builds left
 * them after a stop or exit, so their Run can retire. Only an exact process exit counts; a live or
 * unverifiable process keeps its row. Each host is listed once per sweep.
 */
async function releaseExitedWorkerTerminals(
  runtime: WorkerTerminalReleaseRuntime,
  stopped: () => boolean
): Promise<number> {
  const db = runtime.getExistingOrchestrationDb()
  if (!db) {
    return 0
  }
  const inventories = new Map<string, Promise<readonly PtyProcessInfo[] | null>>()
  let released = 0
  let structuredHostReady = false
  let after = 0
  while (!stopped()) {
    const page = db.listSettledWorkerTerminalsStillOwned(after, PAGE_ROWS)
    const exited: { requestingDispatchId: string; resourceId: string; processIncarnation: string }[] =
      []
    for (const resource of page) {
      after = resource.row_id
      const processIncarnation = resource.process_incarnation
      if (!processIncarnation || stopped()) {
        continue
      }
      if (!structuredHostReady && isStructuredWorkerHandle(resource.terminal_handle)) {
        // Structured liveness reads the session host's durable records.
        structuredHostReady = true
        await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      }
      const liveness = await runtime
        .inspectTerminalProcessIncarnationLiveness(
          processIncarnation,
          resource.host_scope,
          inventories
        )
        .catch(() => 'unverifiable' as const)
      if (liveness === 'exited') {
        exited.push({
          requestingDispatchId: resource.owner_dispatch_id,
          resourceId: resource.id,
          processIncarnation
        })
      }
    }
    // The release re-checks owner, incarnation and ownership in its own transaction.
    if (exited.length > 0 && !stopped()) {
      released += db.settleDeadWorkerTerminalReleases(exited)
    }
    if (page.length < PAGE_ROWS) {
      break
    }
  }
  return released
}
