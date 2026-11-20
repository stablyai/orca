import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import {
  isMintedPtyIncarnation,
  type WorkerTerminalProcessIndex
} from './worker-terminal-process-liveness'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { archiveWorkerOutputBeforeStop } from '../../../rpc/methods/orchestration/worker/stop/worker-stop-archive'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

// Rows handled between yields, so a long backlog never holds main for long.
const ROWS_PER_SLICE = 500

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
 * unverifiable process keeps its row. Each host is listed once per sweep. Chat workers can restart on
 * mail between the check and the release, so only their proven stop releases them.
 */
async function releaseExitedWorkerTerminals(
  runtime: WorkerTerminalReleaseRuntime,
  stopped: () => boolean
): Promise<number> {
  const db = runtime.getExistingOrchestrationDb()
  if (!db) {
    return 0
  }
  // Timestamps are whole seconds: only rows written before the sweep's second are listed.
  const fence = readSqliteNow(db)
  // Every row is listed before any host is: a process alive when its row was read is in the listing.
  // Yields while listing are fine: the fence keeps out rows written since, and hosts are listed after.
  const candidates: { resource: WorkerTerminalResourceRow; processIncarnation: string }[] = []
  for (let after = ''; ;) {
    const page = db.listSettledWorkerTerminalsStillOwned(after, ROWS_PER_SLICE, fence)
    for (const resource of page) {
      after = resource.owner_dispatch_id
      const processIncarnation = resource.process_incarnation
      if (resource.eligible && processIncarnation && isMintedPtyIncarnation(processIncarnation)) {
        candidates.push({ resource, processIncarnation })
      }
    }
    if (page.length < ROWS_PER_SLICE) {
      break
    }
    await yieldToEventLoop()
    if (stopped()) {
      return 0
    }
  }
  const inventories = new Map<string, Promise<WorkerTerminalProcessIndex | null>>()
  let released = 0
  for (let start = 0; start < candidates.length; start += ROWS_PER_SLICE) {
    if (start > 0) {
      await yieldToEventLoop()
    }
    if (stopped()) {
      return released
    }
    released += await releaseExitedSlice(
      runtime,
      db,
      candidates.slice(start, start + ROWS_PER_SLICE),
      inventories,
      stopped
    )
  }
  return released
}

async function releaseExitedSlice(
  runtime: WorkerTerminalReleaseRuntime,
  db: OrchestrationDb,
  candidates: { resource: WorkerTerminalResourceRow; processIncarnation: string }[],
  inventories: Map<string, Promise<WorkerTerminalProcessIndex | null>>,
  stopped: () => boolean
): Promise<number> {
  const exited: {
    requestingDispatchId: string
    resourceId: string
    processIncarnation: string
    terminalHandle: string
    attachedAt: string
  }[] = []
  for (const { resource, processIncarnation } of candidates) {
    if (stopped()) {
      return 0
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
  if (exited.length === 0 || stopped()) {
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
  // One write per slice, so Crew readers wake once per slice; it re-checks owner, incarnation and archive.
  return db.settleDeadWorkerTerminalReleases(exited)
}

function readSqliteNow(db: OrchestrationDb): string {
  return String(db.db.prepare("SELECT datetime('now') AS now").get()?.now)
}
