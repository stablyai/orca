import type { RunCoordinatorIdentity } from '../../orchestration/run-coordinator-authority'
import type { RunRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'

export async function observeRunCoordinator(
  runtime: OrcaRuntimeService,
  run: RunRow,
  resolvedIdentity?: RunCoordinatorIdentity | null
) {
  let status: 'live' | 'unverifiable' | 'exited' = 'unverifiable'
  const processIncarnation =
    run.coordinator_process_incarnation ?? resolvedIdentity?.processIncarnation
  const hostScope = run.coordinator_host_scope ?? resolvedIdentity?.hostScope
  if (processIncarnation && hostScope) {
    status = await runtime.inspectTerminalProcessIncarnationLiveness(processIncarnation, hostScope)
  } else if (run.coordinator_handle) {
    const verdict = runtime.getTerminalLivenessVerdict(run.coordinator_handle)
    if (runtime.getLiveTerminalPaneKey(run.coordinator_handle) || verdict?.status === 'live') {
      status = 'live'
    } else if (verdict?.status === 'unverifiable') {
      status = 'unverifiable'
    } else if (verdict?.status === 'exited') {
      status = 'exited'
    }
  }
  return {
    coordinatorHandle: run.coordinator_handle,
    coordinatorPaneKey: run.coordinator_pane_key,
    coordinatorProcessIncarnation: run.coordinator_process_incarnation,
    coordinatorHostScope: run.coordinator_host_scope,
    status
  }
}
