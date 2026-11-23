import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { isEquivalentPaneKey } from '../../../../../orchestration/db/pane-key-match'
import {
  listWorkerBoundTerminals,
  unbindWorkerTerminal
} from '../../../../../orchestration/db/worker-terminal/worker-bound-terminals'

const FAILED_SETUP_STATES = new Set(['failed', 'spawn_failed'])

/** After a worker closed: close the terminals bound to it. A failed setup stays open to show its error. */
export async function closeWorkerBoundTerminals(
  runtime: Pick<OrcaRuntimeService, 'getTerminalPaneKey' | 'closeTerminal'>,
  db: OrchestrationDb,
  originDispatchId: string
): Promise<void> {
  for (const bound of listWorkerBoundTerminals(db, originDispatchId)) {
    // Checked per row: earlier closes await, and Keep open or a setup failure may land meanwhile.
    if (!unbindWorkerTerminal(db, bound.terminal_handle)) {
      continue
    }
    if (
      bound.role === 'setup' &&
      FAILED_SETUP_STATES.has(db.getWorkerDispatch(originDispatchId)?.setup_state ?? '')
    ) {
      continue
    }
    // A handle that no longer names the bound pane is someone else's terminal now.
    const paneKey = runtime.getTerminalPaneKey(bound.terminal_handle)
    if (!paneKey || !isEquivalentPaneKey(paneKey, bound.pane_key)) {
      continue
    }
    await runtime.closeTerminal(bound.terminal_handle).catch((error: unknown) => {
      console.warn('[orchestration] bound terminal close failed', bound.terminal_handle, error)
    })
  }
}
