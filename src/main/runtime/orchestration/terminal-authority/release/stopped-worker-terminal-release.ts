import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import type { WorkerTerminalProcessIndex } from './worker-terminal-process-liveness'
import { archiveWorkerOutputBeforeStop } from '../../../rpc/methods/orchestration/worker/stop/worker-stop-archive'
import type { OrchestrationDb } from '../../db/orchestration-db'
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
 * Releases settled terminal workers' rows that are still owned and never requested, as older builds
 * left them after a stop or exit, so their Run can retire. Only an exact process exit counts; a live or
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
  const inventories = new Map<string, Promise<WorkerTerminalProcessIndex | null>>()
  // Timestamps are whole seconds: only rows written before the sweep's second predate every listing.
  const fence = readSqliteNow(db)
  const exited: {
    requestingDispatchId: string
    resourceId: string
    processIncarnation: string
    terminalHandle: string
    attachedAt: string
  }[] = []
  let after = 0
  for (;;) {
    const page = db.listSettledWorkerTerminalsStillOwned(after, PAGE_ROWS, fence)
    for (const resource of page) {
      after = resource.row_id
      if (stopped()) {
        return 0
      }
      const processIncarnation = resource.process_incarnation
      if (!processIncarnation) {
        continue
      }
      // A chat worker can restart on mail between this check and the release; only its stop settles it.
      if (isStructuredWorkerHandle(resource.terminal_handle)) {
        continue
      }
      const liveness = await runtime
        .inspectTerminalProcessIncarnationLiveness(
          processIncarnation,
          resource.host_scope,
          inventories
        )
        .catch(() => 'unverifiable' as const)
      if (liveness !== 'exited') {
        continue
      }
      exited.push({
        requestingDispatchId: resource.owner_dispatch_id,
        resourceId: resource.id,
        processIncarnation,
        terminalHandle: resource.terminal_handle,
        attachedAt:
          db.getWorkerDispatch(resource.owner_dispatch_id)?.created_at ?? resource.created_at
      })
    }
    if (page.length < PAGE_ROWS) {
      break
    }
  }
  // A wall clock stepped back since the fence could let a newer row slip under it.
  if (exited.length === 0 || stopped() || readSqliteNow(db) < fence) {
    return 0
  }
  for (const release of exited) {
    // Record where its output still lives, as a stop does; synchronous, so nothing runs in between.
    archiveWorkerOutputBeforeStop({
      runtime,
      db,
      dispatchId: release.requestingDispatchId,
      terminalHandle: release.terminalHandle,
      attachedAt: release.attachedAt
    })
  }
  // One write, so Crew readers wake once per sweep; it re-checks owner, incarnation and archive.
  return db.settleDeadWorkerTerminalReleases(exited)
}

function readSqliteNow(db: OrchestrationDb): string {
  return String(db.db.prepare("SELECT datetime('now') AS now").get()?.now)
}
