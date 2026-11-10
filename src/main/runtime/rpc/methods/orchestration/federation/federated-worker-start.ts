import type { FederatedWorkerStartRequest } from './federated-worker-start-request'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimeStatus } from '../../../../../../shared/runtime-session-contracts'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_TURN_STOP_REPORTS_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { orchestrationMigrationData } from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  assertWorkerLaunchPreferencesRuntimeSupported,
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
import { isWorkerStartTimeoutWithinTimerLimit } from '../../../../../../shared/orchestration/orchestration-timing-budgets'
import {
  federatedFailedReceipt,
  federatedUnknownReceipt,
  isKnownRemoteStartFailure
} from './federated-worker-start-receipts'
import { releaseRetriedWorkerTerminal } from '../worker/retried-worker-terminal-release'
import { withWorkerStartNext } from '../receipt-next'
import { recordReadyFederatedDispatch } from './federated-worker-ready-record'
import { resolveFederatedChildParent } from './federated-worker-child-parent'
import { prepareWorkerStartCard } from '../../../../orchestration/workers/launch/worker-start-card'
import {
  recordWorkerLaunchObservation,
  workerLaunchAgent
} from '../../../../orchestration/workers/launch/worker-launch-observation'

export async function startFederatedWorker(args: FederatedWorkerStartRequest): Promise<unknown> {
  const { params, runtime, db, task, orchestrationMutation } = args
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
  if (worktree === 'current') {
    throw new OrchestrationError(
      'invalid_argument',
      '--on requires an exact remote worktree selector, new-child or new-top-level.'
    )
  }
  const createsWorktree = worktree === 'new-top-level' || worktree === 'new-child'
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
  const childParent =
    worktree === 'new-child'
      ? await resolveFederatedChildParent({
          runtime,
          from: params.from,
          callerSession: args.callerSession,
          serverCapabilities: status.capabilities,
          serverName: server.name
        })
      : undefined
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

  const setupDecision = createsWorktree ? (params.setup ?? 'inherit') : 'not_applicable'
  const runId = args.bindRunId()
  const started = db.createStartingWorkerDispatch({
    creator: resolveDispatchCreator(runtime, params.from, args.callerSession),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    taskId: task?.id,
    taskSpec: params.spec,
    taskTitle: params.taskTitle,
    taskDeps: args.taskDeps,
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
  // A remote retry can replace a failed local attempt whose terminal is still live here.
  releaseRetriedWorkerTerminal(runtime, db, { retryOf: params.retryOf })
  const createdTask = started.task
  const taskForRemote = task ?? createdTask
  db.recordWorkerStage({ dispatchId: started.dispatch.id, stage: 'remote_attach_requested' })
  let readyResult: unknown
  let launch = requestedLaunch
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
          // A server creates new-child as top-level plus this parent, so older servers parse it too.
          worktree: createsWorktree ? 'new-top-level' : worktree,
          ...(childParent && 'crossStoreParent' in childParent
            ? {
                crossStoreParent: childParent.crossStoreParent,
                crossStoreParentInferredFrom: childParent.crossStoreParentInferredFrom
              }
            : {}),
          name: params.name,
          repo: params.repo,
          baseBranch: params.baseBranch,
          displayName: params.displayName,
          ...(params.displayName !== undefined ? { displayNameKind: 'user' as const } : {}),
          comment: params.comment,
          setup: createsWorktree ? params.setup : undefined,
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
    recordWorkerLaunchObservation(db, started.dispatch.id, remote.launch)
    launch = resolveFederatedWorkerLaunchReceipt(
      remote.launch,
      requestedLaunch,
      remote.state === 'ready'
    )
    if (isReadyRemoteFederatedWorkerStartReceipt(remote)) {
      recordReadyFederatedDispatch(db, started.dispatch.id, remote)
      const readyWorker = db.markWorkerDispatchReady(started.dispatch.id)
      runtime.ensureOrchestrationFederationRelay(runId)
      const reportsTurnStops = status.capabilities?.includes(
        ORCHESTRATION_WORKER_TURN_STOP_REPORTS_RUNTIME_CAPABILITY
      )
      readyResult = withWorkerStartNext(
        {
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
          residualResources: remote.residualResources ?? [],
          ...(childParent && 'warning' in childParent ? { warning: childParent.warning } : {})
        },
        reportsTurnStops
          ? undefined
          : {
              name: server.name,
              dispatchId: started.dispatch.id,
              cli: params.from ? runtime.getTerminalOrchestrationCliCommand(params.from) : 'orca'
            }
      )
    } else if (remote.state === 'outcome_unknown') {
      const worker = db.markWorkerStartUnknown(
        started.dispatch.id,
        remote.failedStage ?? 'remote_attach',
        remote.lastError ?? 'The worker server reported an unknown start outcome.'
      )
      return federatedUnknownReceipt(worker, taskForRemote.id, server.name, launch)
    } else {
      const worker = db.failWorkerStart(
        started.dispatch.id,
        remote.failedStage ?? 'remote_attach',
        remote.lastError ?? `The worker server returned ${remote.state}.`
      )
      return federatedFailedReceipt(worker, { runId, taskId: taskForRemote.id }, server, {
        setup: remote.setup,
        launch,
        effects: remote.effects,
        residualResources: remote.residualResources
      })
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (error instanceof OrchestrationError && isKnownRemoteStartFailure(error.code)) {
      const worker = db.failWorkerStart(started.dispatch.id, 'remote_attach', reason)
      return federatedFailedReceipt(worker, { runId, taskId: taskForRemote.id }, server, {
        launch: requestedLaunch
      })
    }
    const worker = db.markWorkerStartUnknown(started.dispatch.id, 'remote_attach', reason)
    return federatedUnknownReceipt(worker, taskForRemote.id, server.name, requestedLaunch)
  }
  if (!params.terminal) {
    recordStart({
      dispatchId: started.dispatch.id,
      workerAddress: `dispatch:${started.dispatch.id}`,
      task: taskForRemote.spec,
      agent: workerLaunchAgent(launch) ?? workerLaunchAgent(requestedLaunch)
    })
  }
  return readyResult
}
