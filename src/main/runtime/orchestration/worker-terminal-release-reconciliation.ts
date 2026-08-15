import type { OrcaRuntimeService } from '../orca-runtime'
import { completeWorkerTerminalRelease } from '../rpc/methods/orchestration-worker-release-completion'
import { reconcileWorkerWorktreeLifecycles } from './worker-worktree-lifecycle-reconciliation'

export type WorkerTerminalReleaseReconciliationResult = {
  attempted: number
  released: number
  pending: number
  unknown: number
  retained: number
}

type ActiveReconciliation = {
  rerunRequested: boolean
  promise?: Promise<WorkerTerminalReleaseReconciliationResult>
}

const activeReconciliationByRuntime = new WeakMap<OrcaRuntimeService, ActiveReconciliation>()

// Converges terminal and Orca-created worktree lifecycles after startup/reconnect discovery.
// Existing release intent is retried first; then exact merged-PR evidence may settle a stale idle
// worker and request its ordinary release. Retained/failed/unproven resources remain untouched.
export function reconcileRequestedWorkerTerminalReleases(
  runtime: OrcaRuntimeService
): Promise<WorkerTerminalReleaseReconciliationResult> {
  const active = activeReconciliationByRuntime.get(runtime)
  if (active?.promise) {
    active.rerunRequested = true
    return active.promise
  }
  const state: ActiveReconciliation = { rerunRequested: false }
  const reconciliation = runReconciliationPasses(runtime, state).finally(() => {
    if (activeReconciliationByRuntime.get(runtime) === state) {
      activeReconciliationByRuntime.delete(runtime)
    }
  })
  state.promise = reconciliation
  activeReconciliationByRuntime.set(runtime, state)
  return reconciliation
}

async function runReconciliationPasses(
  runtime: OrcaRuntimeService,
  state: ActiveReconciliation
): Promise<WorkerTerminalReleaseReconciliationResult> {
  const combined = emptyResult()
  do {
    state.rerunRequested = false
    const pass = await reconcileRequestedWorkerTerminalReleasesOnce(runtime)
    combined.attempted += pass.attempted
    combined.released += pass.released
    combined.pending += pass.pending
    combined.unknown += pass.unknown
    combined.retained += pass.retained
    // Why: a crash can land after GitHub merged the PR but before task settlement, terminal
    // release, or worktree removal. Terminal inventory is the existing startup/reconnect recovery
    // boundary, so extend the SAME coalesced pass instead of adding a cleanup scheduler. Keeping
    // this inside the rerun loop also consumes a request that arrives during async GitHub lookup.
    try {
      const worktrees = await reconcileWorkerWorktreeLifecycles(runtime)
      if (worktrees.attempted > 0) {
        console.info('[orchestration] worker worktree lifecycle reconciliation', {
          attempted: worktrees.attempted,
          removed: worktrees.removed,
          alreadyRemoved: worktrees.alreadyRemoved,
          retained: worktrees.retained,
          releasePending: worktrees.releasePending
        })
      }
    } catch (error) {
      console.warn('[orchestration] worker worktree lifecycle reconciliation failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  } while (state.rerunRequested)
  if (combined.attempted > 0) {
    // Structured counts only; never transcript content or paths.
    console.info('[orchestration] worker terminal release reconciliation', combined)
  }
  return combined
}

async function reconcileRequestedWorkerTerminalReleasesOnce(
  runtime: OrcaRuntimeService
): Promise<WorkerTerminalReleaseReconciliationResult> {
  const db = runtime.getOrchestrationDb()
  const backlog = db.listWorkerTerminalReleaseBacklog()
  const result = { ...emptyResult(), attempted: backlog.length }
  for (const resource of backlog) {
    try {
      const receipt = await completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId: resource.owner_dispatch_id,
        resource,
        mode: 'recovery'
      })
      if (receipt.state === 'released' || receipt.state === 'already_released') {
        result.released += 1
      } else if (receipt.state === 'release_pending') {
        result.pending += 1
      } else if (receipt.state === 'release_unknown') {
        result.unknown += 1
      } else {
        result.retained += 1
      }
    } catch (error) {
      // Archive or endpoint failure: durable intent stays requested; a later discovery retries.
      console.warn('[orchestration] worker terminal release retry failed', {
        resourceId: resource.id,
        dispatchId: resource.owner_dispatch_id,
        error: error instanceof Error ? error.message : String(error)
      })
      result.pending += 1
    }
  }
  return result
}

function emptyResult(): WorkerTerminalReleaseReconciliationResult {
  return { attempted: 0, released: 0, pending: 0, unknown: 0, retained: 0 }
}
