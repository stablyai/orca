import { waitForWorkerAgentReady } from '../../../../launched-agent-composer-readiness'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { describeTerminalWaitBlockedReason } from '../../../../../../shared/terminal-wait-blocked-reason-legacy-alias'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import type {
  OrchestrationCallerIdentity,
  OrchestrationSessionCaller
} from '../../../../orchestration/orchestration-caller-identity'
import { resolveDispatchCreator } from '../runs/dispatch-creator'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import {
  resolveWorkerStartModeOnHost,
  type WorkerStartModeReceipt
} from '../../orchestration-worker-start-mode'
import { EXISTING_WORKTREE_SETUP, placeWorkerAgent } from './worker-start-agent-placement'
import { awaitWorkerSetupGate } from './worker-start-setup-gate'
import { assertOrchestrationWorktreeCreationSupported } from './folder-worktree-placement'
import type { WorkerStartInput } from './worker-start-schema'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome,
  remainingLaunchObservationMs
} from './worker-setup-gate'
import { failWorkerStartWithReceipt } from './worker-start-receipt'
import { parseTaskDeps } from './task-deps-argument'
import { assertExplicitWorkerTerminalUsable } from './explicit-worker-terminal-validation'
import { recordCreatedWorkerTerminalCustody } from './created-worker-terminal-custody'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import { requireWorkerAuthority, type WorkerEffect } from './worker-topology'
import { prepareLocalWorkerAgentLaunch } from './local-worker-agent-launch'
import { deliverAndSettleWorkerStartReadiness } from './worker-start-readiness-settlement'
import { createWorkerLaunchBriefFactory } from './worker-launch-brief'

type WorkerStartMutation = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

export async function startLocalWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  coordinator: OrchestrationCallerIdentity | null
  callerSession?: OrchestrationSessionCaller
  existingTask?: TaskRow
  orchestrationMutation?: WorkerStartMutation
  /** Settings-driven; the executing host still gets to refuse below. */
  mode: WorkerStartModeReceipt
}): Promise<unknown> {
  const { params, runtime, db, run, coordinator, callerSession, existingTask } = args
  const { orchestrationMutation } = args
  const coordinatorPane = coordinator?.paneKey ?? null
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  const { agent, launch } = await prepareLocalWorkerAgentLaunch({
    runtime,
    params,
    callerSession,
    createsWorktree,
    requestedWorktree
  })

  const coordinatorWorktreeId = await resolveDispatchCallerWorktreeId(
    runtime,
    params.from,
    callerSession
  )
  const creationWorktree = createsWorktree
    ? await runtime.showManagedWorktree(`id:${coordinatorWorktreeId}`)
    : undefined
  if (creationWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo ?? creationWorktree.repoId,
      existingPlacement: 'current or an exact existing folder workspace'
    })
  }
  let resolvedWorktree = creationWorktree
    ? undefined
    : requestedWorktree === 'current'
      ? await runtime.showManagedTerminalWorkspace(`id:${coordinatorWorktreeId}`)
      : await runtime.showManagedTerminalWorkspace(requestedWorktree)
  if (params.terminal) {
    await assertExplicitWorkerTerminalUsable({
      runtime,
      terminal: params.terminal,
      from: params.from,
      coordinator,
      resolvedWorktreeId: resolvedWorktree?.id
    })
  }
  let mode = await resolveWorkerStartModeOnHost(runtime, args.mode, resolvedWorktree?.id, agent)

  const startOptions = {
    worktree: requestedWorktree,
    mode,
    resolvedWorktreeId: resolvedWorktree?.id ?? null,
    name: params.name ?? null,
    repo: params.repo ?? creationWorktree?.repoId ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: agent ?? null,
    launch: launch.receipt,
    timeoutMs: params.timeoutMs ?? 60_000,
    setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: createsWorktree
      ? params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
  const started = db.createStartingWorkerDispatch({
    creator: resolveDispatchCreator(runtime, params.from, callerSession),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    taskId: existingTask?.id,
    taskSpec: params.spec,
    taskTitle: params.taskTitle,
    taskDeps: parseTaskDeps(params.deps),
    taskParentId: params.parent,
    taskRunId: run.id,
    // A handle-less session creates root Tasks: Task lineage is recorded by terminal only.
    taskCreatedByTerminalHandle: coordinator?.terminalHandle ?? undefined,
    taskCreatedByPaneKey: coordinatorPane ?? undefined,
    taskCreatedByProcessIncarnation: coordinator?.terminalHandle
      ? (runtime.getTerminalProcessIncarnation(coordinator.terminalHandle) ?? undefined)
      : undefined,
    taskCreatedByRunGeneration: run.consumer_generation,
    retryOf: params.retryOf,
    startOptions,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation
  })
  const effects: WorkerEffect[] = []
  const task = started.task
  if (resolvedWorktree) {
    effects.push(
      { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    )
  }
  let terminalHandle = params.terminal
  let placed: Awaited<ReturnType<typeof placeWorkerAgent>> | undefined
  let failedStage = 'terminal_create'
  const timeoutMs = params.timeoutMs ?? 60_000
  try {
    placed = await placeWorkerAgent({
      runtime,
      db,
      dispatchId: started.dispatch.id,
      taskId: task.id,
      params,
      requestedWorktree,
      creationWorktree,
      resolvedWorktree,
      mode,
      agent,
      launchPreferences: launch.preferences,
      effects,
      onStage: (stage) => {
        failedStage = stage
      },
      ...(params.terminal
        ? {}
        : {
            launchBrief: createWorkerLaunchBriefFactory({
              runtime,
              db,
              agent,
              dispatchId: started.dispatch.id,
              dispatchDepth: started.dispatch.depth,
              taskId: task.id,
              taskSpec: task.spec,
              coordinatorHandle: params.from,
              devMode: params.devMode
            })
          })
    })
    // A created worktree settles its mode only once the host can be asked about it, so the
    // receipt the caller decided is not always the one that ran.
    mode = placed.mode
    resolvedWorktree = placed.worktree
    terminalHandle = placed.terminalHandle
    const structuredSession = placed.structuredSession
    const setupReceipt = placed.setupReceipt
    const setupStage = {
      db,
      dispatchId: started.dispatch.id,
      worktreeId: resolvedWorktree.id,
      terminalHandle,
      setup: setupReceipt,
      effects
    }
    recordCreatedWorkerTerminalCustody(runtime, setupStage, !params.terminal && !structuredSession)
    if (persistGatedSetupSpawnFailure(setupStage)) {
      failedStage = 'setup_start'
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    persistWorkerReadinessStage(setupStage)

    failedStage = 'agent_readiness'
    const launchBrief = placed.launchBrief?.carried ? placed.launchBrief : null
    // A structured session is ready the moment its attach returns ok, and a brief that rode the
    // launch line needs no idle agent to paste into (its dialogs are watched while its turn is
    // observed). Only the repo's wait-for-setup policy still holds either back, waited on here.
    const wait =
      structuredSession || launchBrief
        ? await awaitWorkerSetupGate({
            runtime,
            setup: setupReceipt,
            effects,
            timeoutMs
          })
        : await waitForWorkerAgentReady(runtime, terminalHandle, {
            agent,
            reusesTerminal: Boolean(params.terminal),
            timeoutMs
          })
    if (wait) {
      persistWorkerSetupWaitOutcome({ ...setupStage, wait })
      if (!wait.satisfied) {
        if (setupReceipt.state === 'failed') {
          failedStage = 'setup_wait'
        }
        throw new Error(
          wait.blockedReason
            ? `Agent startup blocked: ${describeTerminalWaitBlockedReason(wait.blockedReason)}`
            : structuredSession
              ? `Setup did not finish before the structured worker started (${wait.status}).`
              : launchBrief
                ? `Setup did not finish before the worker's agent started (${wait.status}).`
                : `Agent did not become ready (${wait.status}).`
        )
      }
    }
    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId: resolvedWorktree.id,
      effects,
      setupState: setupReceipt.state,
      terminalOwnership: params.terminal ? 'external' : 'created'
    })

    return await deliverAndSettleWorkerStartReadiness({
      runtime,
      db,
      run,
      task,
      dispatchId: started.dispatch.id,
      dispatchDepth: started.dispatch.depth,
      structuredSession,
      terminalHandle,
      coordinatorHandle: params.from,
      devMode: params.devMode,
      requestId: orchestrationMutation?.requestId ?? started.dispatch.id,
      agent: agent ?? null,
      launchedAgent: params.terminal ? null : (agent ?? null),
      setupReceipt,
      launchReceipt: launch.receipt,
      mode,
      timeoutMs: params.timeoutMs ?? 60_000,
      effects,
      terminalRevealWarning: placed.warning,
      launchBrief,
      launchObservationTimeoutMs: launchBrief
        ? remainingLaunchObservationMs(timeoutMs, launchBrief.launchStartedAt)
        : timeoutMs,
      onStage: (stage) => {
        failedStage = stage
      }
    })
  } catch (error) {
    await tearDownFailedWorkerStart({
      runtime,
      structuredSession: placed?.structuredSession ?? null,
      dispatchId: started.dispatch.id
    })
    return failWorkerStartWithReceipt({
      db,
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: placed?.setupReceipt ?? EXISTING_WORKTREE_SETUP,
      launch: launch.receipt,
      mode
    })
  }
}
