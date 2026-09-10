import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import type { RpcRequest } from './core'
import { equivalentLegacyPaneKey } from './orchestration-legacy-process-identity'

export function resolveCurrentRunUseAuthority(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  params: Record<string, unknown>
): OrchestrationCompatibilityCallerAuthority | undefined {
  const evidence = request.orchestrationCompatibilityEvidence
  const runId = typeof params.id === 'string' ? params.id : undefined
  const claimedHandle = typeof params.from === 'string' ? params.from : undefined
  const run = runId ? runtime.getOrchestrationDb().getRun(runId) : undefined
  if (
    !run ||
    !evidence?.terminalHandle ||
    !evidence.paneKey ||
    claimedHandle !== evidence.terminalHandle ||
    run.coordinator_handle !== evidence.terminalHandle ||
    !run.coordinator_pane_key ||
    !equivalentLegacyPaneKey(run.coordinator_pane_key, evidence.paneKey)
  ) {
    return undefined
  }
  const caller = runtime.verifyOrchestrationCompatibilityCaller(evidence, {
    currentRuntimeLaunchSufficient: true
  })
  return caller?.terminalHandle === evidence.terminalHandle &&
    equivalentLegacyPaneKey(caller.paneKey, evidence.paneKey)
    ? caller
    : undefined
}
