import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { isEquivalentPaneKey } from '../../../../../orchestration/db/pane-key-match'
import {
  isFailedSetupBinding,
  listWorkerBoundTerminals,
  unbindWorkerTerminal,
  type WorkerBoundTerminalRow
} from '../../../../../orchestration/db/worker-terminal/worker-bound-terminals'

type BoundTerminalCloseRuntime = Pick<
  OrcaRuntimeService,
  'getTerminalPaneKey' | 'getTerminalHandleForPaneKey' | 'closeTerminal'
>

/** After a worker closed: close the terminals bound to it. A failed setup stays open, and bound, to
 *  show its error until the user closes it or a retry succeeds (`closeRetriedFailedSetup`). */
export async function closeWorkerBoundTerminals(
  runtime: BoundTerminalCloseRuntime,
  db: OrchestrationDb,
  originDispatchId: string
): Promise<void> {
  for (const bound of listWorkerBoundTerminals(db, originDispatchId)) {
    // Checked per row: earlier closes await, and Keep open or a setup failure may land meanwhile.
    if (isFailedSetupBinding(db, bound)) {
      continue
    }
    await closeBound(runtime, db, bound)
  }
}

/** A retry that started cleanly replaces the failed attempt, so its kept setup terminal closes now. */
export async function closeRetriedFailedSetup(
  runtime: BoundTerminalCloseRuntime,
  db: OrchestrationDb,
  retryOfDispatchId: string
): Promise<void> {
  const origin =
    db.getWorkerTerminalResourceByOwner(retryOfDispatchId)?.origin_dispatch_id ?? retryOfDispatchId
  for (const bound of listWorkerBoundTerminals(db, origin)) {
    if (isFailedSetupBinding(db, bound)) {
      await closeBound(runtime, db, bound)
    }
  }
}

async function closeBound(
  runtime: BoundTerminalCloseRuntime,
  db: OrchestrationDb,
  bound: WorkerBoundTerminalRow
): Promise<void> {
  if (!unbindWorkerTerminal(db, bound.terminal_handle)) {
    return
  }
  const handle = liveHandle(runtime, bound)
  if (!handle) {
    return
  }
  await runtime.closeTerminal(handle).catch((error: unknown) => {
    console.warn('[orchestration] bound terminal close failed', handle, error)
  })
}

// Handles are reminted when Orca restarts, so a recorded one that no longer resolves is found by its
// pane. Either way the handle must still name the bound pane, or it is someone else's terminal now.
function liveHandle(
  runtime: BoundTerminalCloseRuntime,
  bound: WorkerBoundTerminalRow
): string | null {
  const recorded = runtime.getTerminalPaneKey(bound.terminal_handle)
  if (recorded) {
    return isEquivalentPaneKey(recorded, bound.pane_key) ? bound.terminal_handle : null
  }
  const handle = runtime.getTerminalHandleForPaneKey(bound.pane_key)
  const paneKey = handle ? runtime.getTerminalPaneKey(handle) : null
  return handle && paneKey && isEquivalentPaneKey(paneKey, bound.pane_key) ? handle : null
}

/** After a stop settled: close what is bound to the stopped worker, found through its terminal's origin. */
export async function closeStoppedWorkerTerminals(
  runtime: BoundTerminalCloseRuntime,
  db: OrchestrationDb,
  dispatchId: string
): Promise<void> {
  const origin = db.getWorkerTerminalResourceByOwner(dispatchId)?.origin_dispatch_id
  await closeWorkerBoundTerminals(runtime, db, origin ?? dispatchId)
}
