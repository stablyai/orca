import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import {
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
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
import {
  isReadyRemoteFederatedWorkerStartReceipt,
  parseRemoteFederatedWorkerStartReceipt
} from './federated-attach-receipt'
import { isWorkerStartTimeoutWithinTimerLimit } from '../../../../../../shared/orchestration-timing-budgets'
import {
  federatedFailureReceipt,
  federatedUnknownReceipt,
  isKnownRemoteStartFailure
} from './federated-worker-start-receipts'
import { parseTaskDeps } from '../worker/task-deps-argument'
import { releaseRetriedWorkerTerminal } from '../worker/retried-worker-terminal-release'
import {
  assertFederatedWorkerServerCapabilities,
  resolveFederatedWorkerAgent
} from './federated-worker-default-agent'
import { retriedWorkerDefaultAgent } from '../worker/retried-worker-default-agent'
import { prepareWorkerStartCard } from '../../../../orchestration/worker-start-card'

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
  /** The coordinator's resolved session, when it is one; recorded as the Dispatch creator. */
  callerSession?: OrchestrationSessionCaller
}): Promise<unknown> {
  const { params, runtime, db, task, runId, orchestrationMutation } = args
  const recordStart = prepareWorkerStartCard(runtime, args.callerSession)
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
  assertFederatedWorkerServerCapabilities({
    model: params.model,
    effort: params.effort,
    capabilities: status.capabilities,
    serverName: server.name
  })
  const retried = retriedWorkerDefaultAgent(db, params)
  const { agent: resolvedAgent, selection: agentSelection } = await resolveFederatedWorkerAgent({
    runtime,
    params: retried ? { ...params, agent: retried.agent } : params,
    retriedSelection: retried?.selection,
    server,
    worktree,
    createsWorktree,
    capabilities: status.capabilities,
    preflightTimeoutMs: budgets.preflightTimeoutMs
  })
  const requestedLaunch = createPendingWorkerLaunchReceipt({
    agent: isTuiAgent(resolvedAgent) ? resolvedAgent : null,
    model: params.model,
    effort: params.effort
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
    creator: resolveDispatchCreator(runtime, params.from, args.callerSession),
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
      agent: resolvedAgent ?? null,
      agentSelection: agentSelection ?? null,
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
  // A remote retry can replace a failed local attempt whose terminal is still live here.
  releaseRetriedWorkerTerminal(runtime, db, { retryOf: params.retryOf })
  const createdTask = started.task
  const taskForRemote = task ?? createdTask
  db.recordWorkerStage({ dispatchId: started.dispatch.id, stage: 'remote_attach_requested' })
  let readyResult: unknown
  try {
    const remote = parseRemoteFederatedWorkerStartReceipt(
      await runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'orchestration.federationAttachStart',
        {
          runId,
          dispatchId: started.dispatch.id,
          taskId: taskForRemote.id,
          taskSpec: taskForRemote.spec,
          // Carry home dispatch depth so remote workers cannot re-enter as roots when nesting.
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
          agent: resolvedAgent,
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
    if (isReadyRemoteFederatedWorkerStartReceipt(remote)) {
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
      readyResult = {
        runId,
        taskId: taskForRemote.id,
        dispatchId: started.dispatch.id,
        state: 'ready',
        stage: readyWorker.stage,
        server: { environmentId: server.environmentId, name: server.name },
        setup: remote.setup,
        launch,
        ...(agentSelection ? { agentSelection } : {}),
        timeoutMs: budgets.readinessTimeoutMs,
        effects: remote.effects ?? [],
        residualResources: remote.residualResources ?? []
      }
    } else if (remote.state === 'outcome_unknown') {
      const worker = db.markWorkerStartUnknown(
        started.dispatch.id,
        remote.failedStage ?? 'remote_attach',
        remote.lastError ?? 'The worker server reported an unknown start outcome.'
      )
      return federatedUnknownReceipt(worker, taskForRemote.id, server.name, launch, agentSelection)
    } else {
      const worker = db.failWorkerStart(
        started.dispatch.id,
        remote.failedStage ?? 'remote_attach',
        remote.lastError ?? `The worker server returned ${remote.state}.`
      )
      return federatedFailureReceipt({
        worker,
        runId,
        taskId: taskForRemote.id,
        server,
        launch,
        agentSelection,
        remote
      })
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (error instanceof OrchestrationError && isKnownRemoteStartFailure(error.code)) {
      const worker = db.failWorkerStart(started.dispatch.id, 'remote_attach', reason)
      return federatedFailureReceipt({
        worker,
        runId,
        taskId: taskForRemote.id,
        server,
        launch: requestedLaunch,
        agentSelection
      })
    }
    const worker = db.markWorkerStartUnknown(started.dispatch.id, 'remote_attach', reason)
    return federatedUnknownReceipt(
      worker,
      taskForRemote.id,
      server.name,
      requestedLaunch,
      agentSelection
    )
  }
  if (!params.terminal) {
    recordStart({
      dispatchId: started.dispatch.id,
      workerAddress: `dispatch:${started.dispatch.id}`,
      task: taskForRemote.spec
    })
  }
  return readyResult
}
