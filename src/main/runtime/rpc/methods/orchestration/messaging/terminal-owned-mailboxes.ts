import type { OrchestrationDb } from '../../../../orchestration/db'
import type { DispatchContextRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { hasRunBindingKey } from '../../../../orchestration/orchestration-caller-identity'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import { callerHoldsDispatchPane } from './dispatch-mailbox-fence'

export type TerminalOwnedMailboxes = {
  /** The canonical addresses this terminal's live pane reads: itself, its bound Run, its Dispatch. */
  addresses: ReadonlySet<string>
  /** The Dispatch the live pane and process currently hold. */
  dispatch: DispatchContextRow | undefined
  /** The Run the live pane currently coordinates. */
  runId: string | undefined
}

/**
 * The mailboxes `check` reads for this terminal, validated against its live pane and process.
 * Why: routing rewrites a handle to `run:`/`dispatch:`, so owning mail means owning those exact rows.
 */
export function resolveTerminalOwnedMailboxes(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  handle: string
): TerminalOwnedMailboxes {
  const addresses = new Set([handle])
  const paneKey = runtime.getLiveTerminalPaneKey(handle) ?? undefined
  const caller = orchestrationCallerIdentity(runtime, { handle, paneKey, session: undefined })
  const run = hasRunBindingKey(caller) ? db.getCurrentRunForCoordinator(caller) : undefined
  if (run) {
    addresses.add(`run:${run.id}`)
  }
  const candidate = paneKey ? db.getActiveDispatchForIdentity(handle, paneKey) : undefined
  const dispatch =
    candidate &&
    callerHoldsDispatchPane(candidate, paneKey) &&
    (candidate.process_incarnation === null ||
      runtime.getTerminalProcessIncarnation(handle) === candidate.process_incarnation)
      ? candidate
      : undefined
  if (dispatch) {
    addresses.add(`dispatch:${dispatch.id}`)
  }
  return { addresses, dispatch, runId: run?.id }
}
