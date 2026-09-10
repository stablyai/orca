import { initializeWorkerStartResources } from './worker-start-resource-state'
import { beginLocalWorkerDispatch } from './local-worker-dispatch-start'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { MaestroTerminalLease } from '../../../../../../shared/maestro-terminal-lease'
import { resolveReplacementWorkerStart } from './worker-start-schema'
import { requireWorkerAuthority, resolveWorkerTerminalTitle } from './worker-topology'
import { monitorWorkerSetup } from './worker-setup-monitor'
import { prepareLocalWorkerTerminalSetup } from './local-worker-terminal-setup'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './worker-setup-gate'
import { activateWorkerTerminalLease } from './worker-terminal-lease-activation'
import { prepareLocalWorkerTerminalLease } from './worker-terminal-lease-preparation'
import {
  assertWorkerTerminalIncarnation,
  prepareLocalWorkerStartTopology
} from './worker-start-validation'
import { recoverWorkerStartFailure } from '../../orchestration-worker-start-recovery'
import { resolveWorkerStartReadinessTimeoutMs } from '../../../../../../shared/orchestration-timing-budgets'
import { buildWorkerTerminalLaunchProfile } from '../../../../orchestration/db/worker-terminal/worker-terminal-start-authority'
import { TUI_AGENT_CONFIG } from '../../../../../../shared/tui-agent-config'
import { isVisibleDraftComposerReady } from '../../../../../../shared/draft-paste-ready-scanner'

import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import type { WorkerStartInput } from './worker-start-schema'
import { resolveResidualAgentTerminal } from './failed-start-residual-terminal'
import type { DurableWorkerMutationIdentity } from '../../orchestration-worker-terminal-lease-types'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import { startStructuredWorker } from './structured-worker-start'
import * as workerTurnObservation from './worker-start-turn-observation'

export async function startLocalWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  coordinatorPane: string | null
  existingTask?: TaskRow
  orchestrationMutation?: DurableWorkerMutationIdentity
  recordMutationReceipt?: (receipt: unknown) => void
  mode?: WorkerStartModeReceipt
}): Promise<unknown> {
  if (args.mode?.preferred === 'structured') {
    return startStructuredWorker(args as Parameters<typeof startStructuredWorker>[0])
  }
  const mode = args.mode
  const {
    runtime,
    db,
    run,
    coordinatorPane,
    existingTask,
    orchestrationMutation,
    recordMutationReceipt
  } = args
  const params = resolveReplacementWorkerStart(args.params, db)
  const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
  const prepared = await prepareLocalWorkerStartTopology({
    params,
    runtime,
    db,
    runId: run.id,
    taskId: existingTask?.id,
    coordinatorGeneration: run.consumer_generation,
    hasDurableMutation: Boolean(orchestrationMutation)
  })
  const { requestedWorktree, creationWorktree, agent, agentDiscovery } = prepared
  const { launch, retryPreflight, terminalLeaseRetryOf } = prepared
  let { resolvedWorktree } = prepared
  const started = beginLocalWorkerDispatch({
    params,
    runtime,
    db,
    run,
    coordinatorPane,
    existingTask,
    orchestrationMutation,
    prepared,
    readinessTimeoutMs
  })
  const task = started.task
  const attemptId = params.attemptId ?? started.dispatch.id
  const leaseTitle = resolveWorkerTerminalTitle(task)
  let workerLease: MaestroTerminalLease | undefined
  let leaseTransferReceipt: ReturnType<typeof db.transferMaestroWorkerTerminalLease> | undefined
  const initial = initializeWorkerStartResources(resolvedWorktree?.id)
  const effects = initial.effects
  let setupReceipt = initial.setupReceipt
  let terminalHandle = params.terminal
  let terminalRevealWarning: string | undefined
  let failedStage = creationWorktree ? 'worktree_create' : 'terminal_create'
  try {
    const terminalSetup = await prepareLocalWorkerTerminalSetup({
      runtime,
      db,
      dispatchId: started.dispatch.id,
      requestedWorktree,
      creationWorktree,
      resolvedWorktree,
      terminalHandle,
      setupReceipt,
      agent: agent as TuiAgent,
      launchPreferences: launch.preferences,
      taskId: task.id,
      params,
      effects
    })
    resolvedWorktree = terminalSetup.resolvedWorktree
    terminalHandle = terminalSetup.terminalHandle
    setupReceipt = terminalSetup.setupReceipt
    terminalRevealWarning = terminalSetup.terminalRevealWarning
    const resolvedTerminalHandle = terminalSetup.terminalHandle
    const setupStage = terminalSetup.setupStage
    if (persistGatedSetupSpawnFailure(setupStage)) {
      failedStage = 'setup_start'
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    persistWorkerReadinessStage(setupStage)

    const terminal = await runtime.showTerminal(resolvedTerminalHandle)
    assertWorkerTerminalIncarnation(runtime, resolvedTerminalHandle)
    const terminalAuthority = requireWorkerAuthority(runtime, resolvedTerminalHandle)
    let leaseArgs!: Parameters<typeof activateWorkerTerminalLease>[0]
    let preparedLease!: NonNullable<Parameters<typeof activateWorkerTerminalLease>[0]['prepared']>
    const prepareLease = (): void => {
      const leasePrepared = prepareLocalWorkerTerminalLease({
        db,
        runtime,
        attemptId,
        terminalHandle: resolvedTerminalHandle,
        terminal,
        terminalAuthority,
        leaseTitle,
        effects,
        runId: run.id,
        taskId: task.id,
        taskSpec: task.spec,
        canDispatchSubWorkers: started.dispatch.depth < runtime.getNestedWorkerMaxDepth(),
        coordinatorGeneration: run.consumer_generation,
        dispatchId: started.dispatch.id,
        retryOf: terminalLeaseRetryOf,
        worktreeId: resolvedWorktree.id,
        setupState: setupReceipt.state,
        mutation: orchestrationMutation,
        preflightExecutable: prepared.preflightExecutable,
        retryResourceId: retryPreflight?.resourceId,
        retryPreflight,
        retryPredecessorLeaseId: retryPreflight?.predecessorLeaseId,
        launchProfile: buildWorkerTerminalLaunchProfile(launch.receipt.effective),
        coordinatorHandle: params.from,
        devMode: params.devMode,
        externalTerminal: Boolean(params.terminal),
        agentDiscovery,
        recordMutationReceipt,
        onLeaseTransfer: (receipt) => {
          leaseTransferReceipt = receipt
        }
      })
      leaseArgs = leasePrepared.leaseArgs
      preparedLease = leasePrepared.preparedLease
      workerLease = preparedLease.workerLease
      leaseTransferReceipt = preparedLease.transferReceipt
    }
    // A caller-supplied terminal is not ours until readiness succeeds.
    if (!params.terminal) {
      prepareLease()
    }

    failedStage = 'agent_readiness'
    let wait = await runtime.waitForTerminal(resolvedTerminalHandle, {
      condition: 'tui-idle',
      timeoutMs: readinessTimeoutMs
    })
    const readySignal = agent ? TUI_AGENT_CONFIG[agent].draftPasteReadySignal : undefined
    if (!wait.satisfied && readySignal) {
      const refreshedTerminal = await runtime.showTerminal(resolvedTerminalHandle)
      if (isVisibleDraftComposerReady(readySignal, refreshedTerminal.preview)) {
        wait = { ...wait, satisfied: true }
      }
    }
    persistWorkerSetupWaitOutcome({ ...setupStage, wait })
    if (!wait.satisfied) {
      if (setupReceipt.state === 'failed') {
        failedStage = 'setup_wait'
      }
      throw new Error(
        wait.blockedReason
          ? `Agent startup blocked: ${wait.blockedReason}`
          : wait.status === 'exited' && !creationWorktree
            ? `Agent startup ended before readiness (${wait.status}).`
            : 'worker_readiness_unverifiable'
      )
    }

    if (params.terminal) {
      prepareLease()
    }

    failedStage = 'dispatch_input'
    const activated = await activateWorkerTerminalLease({
      ...leaseArgs,
      prepared: preparedLease
    })
    workerLease = activated.workerLease
    leaseTransferReceipt = activated.transferReceipt
    const turnStart = await workerTurnObservation.observeWorkerTurnStart({
      runtime,
      terminalHandle: resolvedTerminalHandle,
      prompt: activated.prompt?.prompt
    })
    monitorWorkerSetup({
      runtime,
      db,
      runId: run.id,
      dispatchId: started.dispatch.id,
      setupReceipt,
      effects
    })
    const currentWorker = db.getWorkerDispatch(started.dispatch.id)
    if (turnStart.verdict === 'unobserved' && currentWorker?.state === 'starting') {
      return workerTurnObservation.createUnobservedWorkerStartReceipt({
        db,
        run,
        task,
        dispatchId: started.dispatch.id,
        attemptId,
        terminalHandle: resolvedTerminalHandle,
        leaseId: workerLease.id,
        agent: agent ?? null,
        setup: setupReceipt,
        launch: launch.receipt,
        mode,
        timeoutMs: readinessTimeoutMs,
        effects,
        turnStart,
        terminalRevealWarning
      })
    }
    const worker =
      currentWorker && currentWorker.state !== 'starting'
        ? currentWorker
        : db.markWorkerDispatchReady(started.dispatch.id, effects)
    const reportedOutcome =
      worker.stage === 'settled' && (worker.state === 'succeeded' || worker.state === 'failed')
        ? worker.state
        : undefined
    const result = {
      runId: run.id,
      taskId: task.id,
      attemptId,
      terminalHandle: resolvedTerminalHandle,
      dispatchId: started.dispatch.id,
      leaseId: workerLease.id,
      readiness: 'ready',
      ...(activated.prompt?.prompt ? { prompt: activated.prompt.prompt } : {}),
      ...(agentDiscovery ? { agentDiscovery } : {}),
      ...(turnStart.verdict !== 'unsupported' ? { turnStart: turnStart.verdict } : {}),
      state: reportedOutcome ? 'ready' : worker.state,
      stage: worker.stage,
      ...(reportedOutcome ? { workerOutcome: reportedOutcome } : {}),
      setup: setupReceipt,
      launch: launch.receipt,
      timeoutMs: readinessTimeoutMs,
      effects,
      residualResources: [],
      ...(leaseTransferReceipt ? { leaseTransfer: leaseTransferReceipt } : {}),
      ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
    }
    recordMutationReceipt?.(result)
    return result
  } catch (error) {
    const residualAgentTerminal = resolveResidualAgentTerminal({
      runtime,
      effects,
      terminalHandle,
      worktreeId: resolvedWorktree?.id ?? null
    })
    return recoverWorkerStartFailure({
      db,
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: setupReceipt,
      launch: launch.receipt,
      attemptId,
      terminalHandle,
      workerLease,
      leaseTransferReceipt,
      residualAgentTerminal,
      recordMutationReceipt
    })
  }
}
