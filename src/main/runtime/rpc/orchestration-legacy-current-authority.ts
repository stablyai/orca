import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'

export function requireCoordinatorHandoffStarter(
  runtime: OrcaRuntimeService,
  params: {
    requestId: string
    runId: string
    from: string
    evidence?: OrchestrationCompatibilityEvidence
  }
) {
  const database = runtime.getOrchestrationDb()
  const run = database.getRun(params.runId)
  const callerPaneKey = runtime.getTerminalPaneKey(params.from)
  const replay = database.getCoordinatorHandoff(params.requestId)
  const predecessor = replay?.predecessorLeaseId
    ? database.getMaestroTerminalLease(replay.predecessorLeaseId)
    : undefined
  const caller = runtime.verifyOrchestrationCompatibilityCaller(params.evidence, {
    currentRuntimeLaunchSufficient: true
  })
  const resumesReservedHandoff = Boolean(
    replay &&
    replay.runId === params.runId &&
    caller?.terminalHandle === params.from &&
    caller.paneKey === callerPaneKey &&
    predecessor?.terminalHandle === params.from &&
    predecessor.paneKey === callerPaneKey &&
    predecessor.ptyIncarnation === caller.processIncarnation
  )
  if (
    !callerPaneKey ||
    (!resumesReservedHandoff &&
      (!run ||
        run.coordinator_handle !== params.from ||
        run.coordinator_pane_key !== callerPaneKey))
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Coordinator authority is stale. Resume the exact handoff request from its predecessor terminal or inspect its durable receipt.',
      {
        effectsApplied: false,
        nextCommandArgs: [
          'maestro',
          'coordinator-handoff',
          '--payload',
          JSON.stringify({ operation: 'show', requestId: params.requestId }),
          '--json'
        ]
      }
    )
  }
  if (!run) {
    throw new OrchestrationError('run_not_found', `Run ${params.runId} was not found.`)
  }
  return { run, callerPaneKey }
}
