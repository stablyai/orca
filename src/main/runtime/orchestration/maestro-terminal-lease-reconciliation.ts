import type { AgentGraphView } from '../../../shared/maestro-contract'
import { buildMaestroTerminalLeaseTitle } from '../../../shared/maestro-terminal-lease'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import { applyMaestroProjection, getMaestroProjection } from './db/maestro/maestro-projection-store'
import { OrchestrationError } from './orchestration-error'

export { reconcileMaestroWorkerLeaseTransfer } from './db/maestro-terminal-lease/maestro-worker-lease-transfer-reconciliation'
export { reconcileMaestroTerminalLease } from './db/maestro-terminal-lease/maestro-coordinator-lease-release'

export async function adoptCurrentCoordinatorLease(args: {
  runtime: OrcaRuntimeService
  runId: string
  generation: number
  terminalHandle: string
  paneKey: string
  agent?: TuiAgent
  spawnedBy: string
  callerAuthority?: OrchestrationCompatibilityCallerAuthority
}): Promise<void> {
  const db = args.runtime.getOrchestrationDb()
  const terminal = await args.runtime.showTerminal(args.terminalHandle)
  const incarnation = args.runtime.getTerminalProcessIncarnation(args.terminalHandle)
  const context = args.runtime.buildTerminalManagedCliContext(args.terminalHandle)
  if (!incarnation) {
    throw new OrchestrationError(
      'terminal_incarnation_mismatch',
      'Current coordinator terminal incarnation is unavailable.'
    )
  }
  if (
    args.callerAuthority &&
    (args.callerAuthority.terminalHandle !== args.terminalHandle ||
      args.callerAuthority.paneKey !== args.paneKey ||
      args.callerAuthority.processIncarnation !== incarnation)
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Coordinator lease adoption does not match the authenticated caller incarnation.'
    )
  }
  const tabId = terminal.tabId ?? args.paneKey.slice(0, args.paneKey.indexOf(':'))
  const currentLease = db.getCoordinatorLease(args.runId, args.generation)
  if (currentLease) {
    if (
      !args.callerAuthority ||
      args.callerAuthority.terminalHandle !== args.terminalHandle ||
      args.callerAuthority.paneKey !== args.paneKey ||
      args.callerAuthority.processIncarnation !== incarnation
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        'Existing coordinator lease adoption requires the authenticated caller incarnation.'
      )
    }
    db.rebindCurrentCoordinatorLease({
      leaseId: currentLease.id,
      executionHostId: context.executionHostId,
      workspaceKey: context.workspaceKey,
      terminalHandle: args.terminalHandle,
      tabId,
      paneKey: args.paneKey,
      ptyIncarnation: incarnation,
      processRootId: terminal.ptyId ?? null
    })
    return
  }
  const agent = args.agent ?? terminal.agentIdentity ?? null
  const lease = db.reserveMaestroTerminalLease({
    requestId: `coordinator:${args.runId}:g${args.generation}`,
    executionHostId: context.executionHostId,
    workspaceKey: context.workspaceKey,
    runId: args.runId,
    coordinatorGeneration: args.generation,
    role: 'coordinator',
    coordinatorRunId: args.runId,
    title: buildMaestroTerminalLeaseTitle({
      role: 'coordinator',
      runId: args.runId,
      coordinatorGeneration: args.generation,
      agent
    }),
    launchProfile: {
      agent,
      model: null,
      effort: null,
      permissionMode: 'unknown',
      routeRef: 'adopted-external-coordinator'
    },
    spawnedBy: args.spawnedBy,
    ownerPrincipal: `external-coordinator:${args.runId}:g${args.generation}`,
    retentionPolicy: 'retain'
  })
  db.attachMaestroTerminalLease({
    leaseId: lease.id,
    terminalHandle: args.terminalHandle,
    tabId,
    paneKey: args.paneKey,
    ptyIncarnation: incarnation,
    processRootId: terminal.ptyId ?? null
  })
  db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'ready' })
  db.retainMaestroTerminalLease(lease.id)
}

export function claimMaestroCoordinatorHandoff(args: {
  runtime: OrcaRuntimeService
  requestId: string
  terminalHandle: string
  view: AgentGraphView
  callerAuthority?: OrchestrationCompatibilityCallerAuthority
}) {
  const db = args.runtime.getOrchestrationDb()
  const handoff = db.getCoordinatorHandoff(args.requestId)
  if (!handoff) {
    throw new OrchestrationError('handoff_not_found', `Handoff ${args.requestId} was not found.`)
  }
  const lease = db.getMaestroTerminalLease(handoff.successorLeaseId)
  const incarnation = args.runtime.getTerminalProcessIncarnation(args.terminalHandle)
  if (
    !lease ||
    lease.terminalHandle !== args.terminalHandle ||
    !incarnation ||
    lease.ptyIncarnation !== incarnation ||
    args.callerAuthority?.terminalHandle !== args.terminalHandle ||
    args.callerAuthority.paneKey !== lease.paneKey ||
    args.callerAuthority.processIncarnation !== incarnation
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Coordinator claim does not come from the reserved successor incarnation.'
    )
  }
  if (
    handoff.phase === 'coordinator_claimed' ||
    handoff.phase === 'authority_committed' ||
    handoff.phase === 'predecessor_reconciled'
  ) {
    return handoff
  }
  if (handoff.phase === 'blocked' || handoff.phase === 'outcome_unknown') {
    throw new OrchestrationError('handoff_phase_conflict', `Handoff is ${handoff.phase}.`)
  }
  const scope = args.view.workspace_scope
  const home = {
    repository_id: scope.repository_id,
    execution_host_id: scope.orchestration_home.execution_host_id,
    workspace_key: scope.orchestration_home.workspace_key,
    run_id: args.view.run_id
  }
  if (
    args.view.run_id !== handoff.runId ||
    args.view.coordinator.generation !== handoff.claimedGeneration ||
    args.view.revision < handoff.expectedGraphRevision ||
    home.execution_host_id !== lease.executionHostId ||
    home.workspace_key !== lease.workspaceKey
  ) {
    throw new OrchestrationError(
      'claim_revision_stale',
      'The successor claim is not the expected Run generation and workspace revision.'
    )
  }
  applyMaestroProjection.call(db, home, args.view)
  const projection = getMaestroProjection.call(db, {
    execution_host_id: lease.executionHostId,
    workspace_key: lease.workspaceKey
  })
  if (
    !projection ||
    projection.runId !== handoff.runId ||
    projection.coordinator.generation !== handoff.claimedGeneration ||
    projection.revision < handoff.expectedGraphRevision
  ) {
    throw new OrchestrationError(
      'claim_revision_stale',
      'The successor has not published the expected authoritative graph revision.'
    )
  }
  const input = db.db
    .prepare('SELECT command_id FROM maestro_terminal_input_receipts WHERE idempotency_key = ?')
    .get(handoff.inputIdempotencyKey) as { command_id: string } | undefined
  if (!input) {
    throw new OrchestrationError('input_not_found', 'Coordinator capsule input is missing.')
  }
  db.transitionMaestroTerminalInput({
    commandId: input.command_id,
    state: 'acknowledged',
    acknowledgedGraphRevision: projection.revision
  })
  db.advanceCoordinatorHandoff({
    requestId: args.requestId,
    phase: 'capsule_delivery_acknowledged'
  })
  return db.advanceCoordinatorHandoff({
    requestId: args.requestId,
    phase: 'coordinator_claimed',
    observedGraphRevision: projection.revision
  })
}
