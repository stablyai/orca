import { negotiateFederatedWorkerProtocol } from './federated-worker-protocol'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import {
  federatedUnknownReceipt,
  isKnownRemoteStartFailure
} from '../../orchestration-federated-start-outcome'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import { ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_PROTOCOL_VERSION } from '../../../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from '../worker/worker-start-schema'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  createPendingWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt
} from '../worker/worker-launch-preferences'
import { validateFederatedWorkerStartPlacement } from '../worker/worker-start-validation'
import { resolveFederatedWorkerStartBudgets } from '../worker/worker-start-budgets'
import { resolveDispatchCreator } from '../runs/dispatch-creator'
import { parseRemoteFederatedWorkerStartReceipt } from './federated-attach-receipt'
import { isWorkerStartTimeoutWithinTimerLimit } from '../../../../../../shared/orchestration-timing-budgets'
import { boundedRedactedDiagnostic } from '../worker/worker-start-receipt'
import { parseTaskDeps } from '../worker/task-deps-argument'

export async function startFederatedWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task?: { id: string; spec: string; status: string }
  orchestrationMutation?: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
}): Promise<unknown> {
  const { params, runtime, db, task, runId, orchestrationMutation } = args
  if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
    )
  }
  if (!orchestrationMutation) {
    throw new OrchestrationError(
      'invalid_argument',
      'Remote worker-start requires a durable retry request.'
    )
  }
  if (params.retryOf) {
    throw new OrchestrationError(
      'capability_unsupported',
      'Federated retry transfer is not supported by the attempt-bound lease protocol. No effects were applied.'
    )
  }
  const run = db.getRun(runId)
  if (!run) {
    throw new OrchestrationError(
      'consumer_fenced',
      `Run ${runId} is not authoritative for federated worker-start. No effects were applied.`
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
  const requestedLaunch = createPendingWorkerLaunchReceipt({
    agent: isTuiAgent(params.agent) ? params.agent : null,
    model: params.model,
    effort: params.effort
  })
  const server = runtime.resolveOrchestrationWorkerServer(params.on as string)
  const pairingFence = { expectedEnvironmentPairingRevision: server.pairingRevision }
  const budgets = resolveFederatedWorkerStartBudgets(params.timeoutMs)
  const status = (await runtime.callOrchestrationWorkerServer(
    server.environmentId,
    'status.get',
    undefined,
    budgets.preflightTimeoutMs,
    undefined,
    pairingFence
  )) as RuntimeStatus
  const federationProtocolVersion = negotiateFederatedWorkerProtocol(status, params, server.name)
  const attemptBoundTransfer =
    federationProtocolVersion ===
    ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_PROTOCOL_VERSION

  const setupDecision = createsWorktree ? (params.setup ?? 'run') : 'not_applicable'
  const started = db.createStartingWorkerDispatch({
    creator: resolveDispatchCreator(runtime, params.from),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    taskId: task?.id,
    taskSpec: params.spec,
    taskTitle: params.taskTitle,
    taskDeps: parseTaskDeps(params.deps),
    taskParentId: params.parent,
    taskRunId: runId,
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
      timeoutMs: budgets.readinessTimeoutMs,
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
  const createdTask = started.task
  const taskForRemote = task ?? createdTask
  const attemptId = params.attemptId ?? started.dispatch.id
  db.recordWorkerStage({ dispatchId: started.dispatch.id, stage: 'remote_attach_requested' })
  try {
    const remote = parseRemoteFederatedWorkerStartReceipt(
      await runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'orchestration.federationAttachStart',
        {
          runId,
          dispatchId: started.dispatch.id,
          taskId: taskForRemote.id,
          ...(attemptBoundTransfer
            ? {
                attemptId,
                runId,
                coordinatorGeneration: run.consumer_generation
              }
            : {}),
          retryOf: params.retryOf,
          taskSpec: taskForRemote.spec,
          // Carry the home dispatch depth across the federation boundary so a
          // remote worker cannot be mistaken for a root when it dispatches again.
          depth: started.dispatch.depth,
          protocolVersion: federationProtocolVersion,
          worktree,
          name: params.name,
          repo: params.repo,
          baseBranch: params.baseBranch,
          displayName: params.displayName,
          ...(params.displayName !== undefined ? { displayNameKind: 'user' as const } : {}),
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
          timeoutMs: budgets.readinessTimeoutMs,
          devMode: params.devMode
        },
        budgets.attachDeadlineMs,
        { orchestrationRequestId: orchestrationMutation.requestId },
        { contractVerified: true, ...pairingFence }
      )
    )
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
    // Why: pane identity is part of the attempt-bound receipt only. A peer that
    // negotiated down never sends it, and demanding it would strand a worker that
    // actually started on an older server.
    if (
      remote.state === 'ready' &&
      remote.runtimeEpoch &&
      remote.worktreeId &&
      remote.terminalHandle &&
      (!attemptBoundTransfer || (remote.paneKey && remote.processIncarnation))
    ) {
      db.updateFederatedDispatchResources({
        dispatchId: started.dispatch.id,
        remoteRuntimeEpoch: remote.runtimeEpoch,
        worktreeId: remote.worktreeId,
        terminalHandle: remote.terminalHandle,
        ...(remote.paneKey ? { paneKey: remote.paneKey } : {}),
        ...(remote.processIncarnation ? { processIncarnation: remote.processIncarnation } : {})
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
        taskId: taskForRemote.id,
        dispatchId: started.dispatch.id,
        state: 'ready',
        stage: readyWorker.stage,
        server: { environmentId: server.environmentId, name: server.name },
        setup: remote.setup,
        launch,
        timeoutMs: budgets.readinessTimeoutMs,
        effects: remote.effects ?? [],
        residualResources: remote.residualResources ?? []
      }
    }
    // Why: a ready receipt without its exact attachment identity cannot later prove release safety.
    if (remote.state === 'ready') {
      const worker = db.markWorkerStartUnknown(
        started.dispatch.id,
        'remote_attach',
        'The worker server accepted the attachment without its authoritative terminal identity.'
      )
      return federatedUnknownReceipt(worker, taskForRemote.id, server.name, launch)
    }
    // Why: remote.lastError can arrive raw/unbounded from an older peer that
    // predates redaction — bound and redact at the home too. Naturally
    // idempotent on an already-sanitized message from a newer peer (see
    // boundedRedactedDiagnostic's own doc comment).
    const remoteFailedStage = remote.failedStage ?? 'remote_attach'
    if (remote.state === 'outcome_unknown') {
      const worker = db.markWorkerStartUnknown(
        started.dispatch.id,
        remoteFailedStage,
        boundedRedactedDiagnostic(
          remote.lastError ?? 'The worker server reported an unknown start outcome.'
        )
      )
      return federatedUnknownReceipt(worker, taskForRemote.id, server.name, launch)
    }
    const worker = db.failWorkerStart(
      started.dispatch.id,
      remoteFailedStage,
      boundedRedactedDiagnostic(remote.lastError ?? `The worker server returned ${remote.state}.`)
    )
    return {
      runId,
      taskId: taskForRemote.id,
      dispatchId: started.dispatch.id,
      state: worker.state,
      stage: worker.stage,
      server: { environmentId: server.environmentId, name: server.name },
      failedStage: worker.stage,
      lastError: worker.last_error,
      setup: remote.setup,
      launch,
      effects: remote.effects ?? [],
      residualResources: remote.residualResources ?? []
    }
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error)
    const reason = boundedRedactedDiagnostic(rawReason)
    if (error instanceof OrchestrationError && isKnownRemoteStartFailure(error.code)) {
      const worker = db.failWorkerStart(started.dispatch.id, 'remote_attach', reason)
      return {
        runId,
        taskId: taskForRemote.id,
        dispatchId: started.dispatch.id,
        state: worker.state,
        stage: worker.stage,
        server: { environmentId: server.environmentId, name: server.name },
        failedStage: worker.stage,
        lastError: worker.last_error,
        launch: requestedLaunch,
        effects: [],
        residualResources: []
      }
    }
    const worker = db.markWorkerStartUnknown(started.dispatch.id, 'remote_attach', reason)
    return federatedUnknownReceipt(worker, taskForRemote.id, server.name, requestedLaunch)
  }
}
