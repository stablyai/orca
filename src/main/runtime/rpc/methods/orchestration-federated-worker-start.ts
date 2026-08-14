import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_SESSION_RESUME_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { orchestrationMigrationData } from '../../../../shared/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { FederatedDispatchRow } from '../../orchestration/types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import {
  assertWorkerLaunchPreferencesRuntimeSupported,
  assertWorkerLaunchPreferencesCreateTerminal,
  createPendingWorkerLaunchReceipt
} from './orchestration-worker-launch-preferences'
import { validateFederatedWorkerStartPlacement } from './orchestration-worker-start-validation'
import {
  failFederatedWorkerStart,
  finalizeFederatedWorkerStart,
  type RemoteStartReceipt
} from './orchestration-federated-worker-start-result'

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
  const resumeSource = params.resumeDispatch
    ? resolveFederatedResumeSource(db, params.resumeDispatch)
    : undefined
  if (resumeSource) {
    assertFederatedResumeOptions(params)
  }
  const worktree = resumeSource
    ? `id:${resumeSource.remote_worktree_id}`
    : (params.worktree ?? 'current')
  if (worktree === 'current' || worktree === 'new-child') {
    throw new OrchestrationError(
      'invalid_argument',
      '--on requires an exact remote worktree selector or new-top-level.'
    )
  }
  const createsWorktree = worktree === 'new-top-level'
  if (!resumeSource) {
    assertWorkerLaunchPreferencesCreateTerminal(params)
    validateFederatedWorkerStartPlacement(params, createsWorktree)
  }
  const requestedLaunch = createPendingWorkerLaunchReceipt({
    agent: resumeSource ? null : isTuiAgent(params.agent) ? params.agent : null,
    model: params.model,
    effort: params.effort
  })

  const server = runtime.resolveOrchestrationWorkerServer(
    resumeSource ? resumeSource.environment_id : (params.on as string)
  )
  if (resumeSource && server.peerFingerprint !== resumeSource.peer_fingerprint) {
    throw new OrchestrationError(
      'resume_host_mismatch',
      `Connected server ${server.name} no longer matches the worker Dispatch owning peer.`
    )
  }
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
  if (
    resumeSource &&
    !status.capabilities?.includes(ORCHESTRATION_WORKER_SESSION_RESUME_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${server.name} does not support native worker session resume.`
    )
  }
  assertWorkerLaunchPreferencesRuntimeSupported({
    model: params.model,
    effort: params.effort,
    capabilities: status.capabilities,
    serverName: server.name
  })
  const supportsControlMail = status.capabilities?.includes(
    ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
  )
  const federationProtocolVersion =
    supportsControlMail &&
    status.capabilities?.includes(ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY)
      ? ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
      : supportsControlMail
        ? ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
        : 1

  const setupDecision = createsWorktree ? (params.setup ?? 'run') : 'not_applicable'
  const started = db.createStartingWorkerDispatch({
    taskId: task.id,
    retryOf: params.retryOf,
    resumeSourceDispatchId: resumeSource?.dispatch_id,
    startOptions: {
      on: server.environmentId,
      serverName: server.name,
      worktree,
      name: params.name ?? null,
      repo: params.repo ?? null,
      baseBranch: params.baseBranch ?? null,
      terminal: params.terminal ?? null,
      agent: resumeSource ? null : (params.agent ?? null),
      resumeDispatch: resumeSource?.dispatch_id ?? null,
      launch: requestedLaunch,
      timeoutMs: params.timeoutMs ?? 60_000,
      setup: setupDecision,
      setupSource: createsWorktree
        ? params.setup
          ? 'explicit_request'
          : 'orchestration_default'
        : 'existing_worktree'
    },
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
        resumeDispatch: resumeSource?.dispatch_id,
        agent: resumeSource ? undefined : params.agent,
        model: resumeSource ? undefined : params.model,
        effort: resumeSource ? undefined : params.effort,
        timeoutMs: params.timeoutMs,
        devMode: params.devMode
      },
      (params.timeoutMs ?? 60_000) + 15_000,
      { orchestrationRequestId: orchestrationMutation.requestId }
    )) as RemoteStartReceipt
    return finalizeFederatedWorkerStart({
      db,
      runtime,
      runId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      server: { environmentId: server.environmentId, name: server.name },
      requestedLaunch,
      timeoutMs: params.timeoutMs ?? 60_000,
      remote
    })
  } catch (error) {
    return failFederatedWorkerStart({
      db,
      runtime,
      runId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      server: { environmentId: server.environmentId, name: server.name },
      requestedLaunch,
      timeoutMs: params.timeoutMs ?? 60_000,
      error,
      resumeSourceDispatchId: resumeSource?.dispatch_id
    })
  }
}

function resolveFederatedResumeSource(
  db: OrchestrationDb,
  sourceDispatchId: string
): FederatedDispatchRow {
  const source = db.getFederatedDispatch(sourceDispatchId)
  const worker = db.getWorkerDispatch(sourceDispatchId)
  if (!source || !worker) {
    throw new OrchestrationError(
      'resume_dispatch_not_found',
      `Federated worker Dispatch ${sourceDispatchId} was not found.`
    )
  }
  if (!['succeeded', 'failed'].includes(worker.state)) {
    throw new OrchestrationError(
      'resume_source_active',
      `Federated worker Dispatch ${sourceDispatchId} is ${worker.state}; only a settled worker can resume.`
    )
  }
  if (!source.remote_worktree_id) {
    throw new OrchestrationError(
      'resume_checkpoint_missing',
      `Federated worker Dispatch ${sourceDispatchId} has no recorded owning worktree.`
    )
  }
  return source
}

function assertFederatedResumeOptions(params: WorkerStartInput): void {
  const conflicting = [
    params.on,
    params.worktree,
    params.name,
    params.repo,
    params.baseBranch,
    params.displayName,
    params.comment,
    params.setup,
    params.terminal,
    params.agent,
    params.model,
    params.effort
  ]
  if (conflicting.some((value) => value !== undefined)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--resume-dispatch cannot combine with placement, creation, terminal, agent, model, or effort options.'
    )
  }
}
