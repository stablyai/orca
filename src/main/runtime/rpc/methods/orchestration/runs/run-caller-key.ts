import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationCoordinatorKey } from '../../../../orchestration/orchestration-caller-identity'
import type { RunCallerKey } from '../../../../orchestration/db/runs/run-actor'

export function resolveRunCallerKey(
  runtime: OrcaRuntimeService,
  caller: OrchestrationCoordinatorKey
): RunCallerKey {
  const authority = caller.terminalHandle
    ? runtime.getOrchestrationDispatchAuthority?.(caller.terminalHandle)
    : null
  return {
    ...caller,
    paneKey: authority?.paneKey ?? caller.paneKey,
    processIncarnation: authority?.processIncarnation ?? null
  }
}
