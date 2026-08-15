import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { TuiAgent } from '../../../../shared/types'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { orchestrationMigrationData } from '../../../../shared/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import {
  assertWorkerLaunchPreferencesRuntimeSupported,
  assertWorkerLaunchPreferencesCreateTerminal,
  createPendingWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt
} from './orchestration-worker-launch-preferences'
import {
  resolveBoundedWorkerControls,
  resolveWorkerDeadlineAt,
  validateFederatedWorkerStartPlacement
} from './orchestration-worker-start-validation'
import {
  settleFederatedStartRuntimeReceipt,
  type RemoteStartReceipt
} from './orchestration-federation-start-receipt'
import { federatedUnknownReceipt } from './orchestration-worker-start-receipt'

export async function startFederatedWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task: { id: string; spec: string; status: string }
  orchestrationMutation?: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
}): Promise<unknown> {
  const { params, runtime, db, task, runId, orchestrationMutation } = args
  if (!orchestrationMutation) {
    throw new OrchestrationError(
      'invalid_argument',
      'Remote worker-start requires a durable retry request.'
    )
  }
  const worktree = params.worktree ?? 'current'
  if (worktree === 'current' || worktree === 'new-child') {
    throw new OrchestrationError(
      'invalid_argument',
      '--on requires an exact remote worktree selector or new-top-level.'
    )
  }
  const createsWorktree = worktree === 'new-top-level'
  assertWorkerLaunchPreferencesCreateTerminal(params)
  validateFederatedWorkerStartPlacement(params, createsWorktree)
  const controls = resolveBoundedWorkerControls(params, params.agent as TuiAgent)
  const deadlineAt = resolveWorkerDeadlineAt({
    db,
    retryOf: params.retryOf,
    maxRuntimeMs: params.maxRuntimeMs
  })
  const bounded = {
    deadlineAt,
    budget: controls.budget,
    leafControl: controls.leafControl
  }
  const requestedLaunch = createPendingWorkerLaunchReceipt({
    agent: isTuiAgent(params.agent) ? params.agent : null,
    model: params.model,
    effort: params.effort
  })

  const server = runtime.resolveOrchestrationWorkerServer(params.on as string)
  const status = (await runtime.callOrchestrationWorkerServer(
    server.environmentId,
    'status.get',
    undefined,
    params.timeoutMs
  )) as RuntimeStatus
  if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'orchestration_migration_required',
      `Connected server ${server.name} does not support the current orchestration contract. No effects were applied.`,
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
  if (!status.capabilities?.includes(ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${server.name} does not support orchestration federation.`
    )
  }
  assertWorkerLaunchPreferencesRuntimeSupported({
    model: params.model,
    effort: params.effort,
    capabilities: status.capabilities,
    serverName: server.name
  })
  const federationProtocolVersion = status.capabilities?.includes(
    ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
  )
    ? ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
    : 1

  const setupDecision = createsWorktree ? (params.setup ?? 'run') : 'not_applicable'
  const started = db.createStartingWorkerDispatch({
    taskId: task.id,
    retryOf: params.retryOf,
    startOptions: {
      on: server.environmentId,
      serverName: server.name,
      worktree,
      name: params.name ?? null,
      repo: params.repo ?? null,
      baseBranch: params.baseBranch ?? null,
      terminal: params.terminal ?? null,
      agent: params.agent ?? null,
      launch: requestedLaunch,
      bounded,
      timeoutMs: params.timeoutMs ?? 60_000,
      setup: setupDecision,
      setupSource: createsWorktree
        ? params.setup
          ? 'explicit_request'
          : 'orchestration_default'
        : 'existing_worktree'
    },
    budget: controls.budget,
    deadlineAt,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation,
    federation: {
      environmentId: server.environmentId,
      environmentName: server.name,
      peerFingerprint: server.peerFingerprint,
      protocolVersion: federationProtocolVersion
    }
  })
  db.recordWorkerStage({ dispatchId: started.dispatch.id, stage: 'remote_attach_requested' })
  try {
    const remote = (await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      'orchestration.federationAttachStart',
      {
        dispatchId: started.dispatch.id,
        taskId: task.id,
        taskSpec: task.spec,
        protocolVersion: federationProtocolVersion,
        worktree,
        name: params.name,
        repo: params.repo,
        baseBranch: params.baseBranch,
        displayName: params.displayName,
        comment: params.comment,
        setup: createsWorktree ? (params.setup ?? 'run') : undefined,
        setupSource: createsWorktree
          ? params.setup
            ? 'explicit_request'
            : 'orchestration_default'
          : undefined,
        terminal: params.terminal,
        agent: params.agent,
        model: params.model,
        effort: params.effort,
        timeoutMs: params.timeoutMs,
        dispatchGroup: params.dispatchGroup,
        dispatchIndex: params.dispatchIndex,
        maxDispatches: params.maxDispatches,
        maxRuntimeMs: params.maxRuntimeMs,
        maxRequests: params.maxRequests,
        maxReviewCycles: params.maxReviewCycles,
        reviewCycle: params.reviewCycle,
        deadlineAt,
        devMode: params.devMode
      },
      (params.timeoutMs ?? 60_000) + 15_000,
      { orchestrationRequestId: orchestrationMutation.requestId }
    )) as RemoteStartReceipt
    if (remote.dispatchId !== started.dispatch.id) {
      throw new OrchestrationError(
        'resource_server_mismatch',
        'The worker server returned a different Dispatch attachment.'
      )
    }
    const launch = resolveFederatedWorkerLaunchReceipt(
      remote.launch,
      requestedLaunch,
      remote.state === 'ready'
    )
    if (remote.state === 'ready' && remote.worktreeId && remote.terminalHandle) {
      db.updateFederatedDispatchResources({
        dispatchId: started.dispatch.id,
        remoteRuntimeEpoch: remote.runtimeEpoch,
        worktreeId: remote.worktreeId,
        terminalHandle: remote.terminalHandle
      })
      db.recordWorkerStage({
        dispatchId: started.dispatch.id,
        stage: 'remote_input_accepted',
        worktreeId: remote.worktreeId,
        terminalHandle: remote.terminalHandle,
        setupState: remote.setup?.state,
        effects: remote.effects,
        residualResources: remote.residualResources
      })
      const readyWorker = db.markWorkerDispatchReady(started.dispatch.id)
      runtime.ensureOrchestrationFederationRelay(runId)
      return {
        runId,
        taskId: task.id,
        dispatchId: started.dispatch.id,
        state: 'ready',
        stage: readyWorker.stage,
        server: { environmentId: server.environmentId, name: server.name },
        setup: remote.setup,
        launch,
        ...bounded,
        timeoutMs: params.timeoutMs ?? 60_000,
        effects: remote.effects ?? [],
        residualResources: remote.residualResources ?? []
      }
    }
    if (remote.state === 'outcome_unknown') {
      const worker = db.markWorkerStartUnknown(
        started.dispatch.id,
        remote.failedStage ?? 'remote_attach',
        remote.lastError ?? 'The worker server reported an unknown start outcome.'
      )
      return federatedUnknownReceipt(worker, task.id, server.name, launch, bounded)
    }
    if (remote.state === 'stopped' || remote.state === 'stop_unknown') {
      return settleFederatedStartRuntimeReceipt({
        db,
        runId,
        taskId: task.id,
        dispatchId: started.dispatch.id,
        server: { environmentId: server.environmentId, name: server.name },
        remote,
        launch,
        bounded
      })
    }
    const worker = db.failWorkerStart(
      started.dispatch.id,
      remote.failedStage ?? 'remote_attach',
      remote.lastError ?? `The worker server returned ${remote.state}.`
    )
    return {
      runId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      state: worker.state,
      stage: worker.stage,
      server: { environmentId: server.environmentId, name: server.name },
      failedStage: worker.stage,
      lastError: worker.last_error,
      setup: remote.setup,
      launch,
      ...bounded,
      effects: remote.effects ?? [],
      residualResources: remote.residualResources ?? []
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (error instanceof OrchestrationError && isKnownRemoteStartFailure(error.code)) {
      const worker = db.failWorkerStart(started.dispatch.id, 'remote_attach', reason)
      return {
        runId,
        taskId: task.id,
        dispatchId: started.dispatch.id,
        state: worker.state,
        stage: worker.stage,
        server: { environmentId: server.environmentId, name: server.name },
        failedStage: worker.stage,
        lastError: worker.last_error,
        launch: requestedLaunch,
        ...bounded,
        effects: [],
        residualResources: []
      }
    }
    const worker = db.markWorkerStartUnknown(started.dispatch.id, 'remote_attach', reason)
    return federatedUnknownReceipt(worker, task.id, server.name, requestedLaunch, bounded)
  }
}

function isKnownRemoteStartFailure(code: string): boolean {
  return [
    'invalid_argument',
    'agent_unconfigured',
    'worktree_not_found_on_server',
    'terminal_worktree_mismatch',
    'capability_unsupported',
    'bounded_worker_requires_fresh_process',
    'leaf_control_unsupported',
    'runtime_budget_exhausted'
  ].includes(code)
}
