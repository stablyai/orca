import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import { resolveDispatchCreator } from '../runs/dispatch-creator'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import {
  resolveWorkerStartModeOnHost,
  type WorkerStartModeReceipt
} from '../../orchestration-worker-start-mode'
import { assertOrchestrationWorktreeCreationSupported } from './folder-worktree-placement'
import type { WorkerStartInput } from './worker-start-schema'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './worker-setup-gate'
import { failWorkerStartWithReceipt } from './worker-start-receipt'
import { parseTaskDeps } from './task-deps-argument'
import { assertExplicitWorkerTerminalUsable } from './explicit-worker-terminal-validation'
import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'
import { recordCreatedWorkerTerminalCustody } from './created-worker-terminal-custody'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import {
  createExistingWorktreeWorkerTerminal,
  createStructuredWorkerSessionForWorktree,
  createWorkerWorktree,
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './worker-topology'
import { prepareLocalWorkerStart } from './worker-start-validation'

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
  coordinatorPane: string | null
  existingTask?: TaskRow
  orchestrationMutation?: WorkerStartMutation
  /** Settings-driven; the executing host still gets to refuse below. */
  mode: WorkerStartModeReceipt
}): Promise<unknown> {
  const { params, runtime, db, run, coordinatorPane, existingTask, orchestrationMutation } = args
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  const { agent, launch } = prepareLocalWorkerStart({ params, createsWorktree, runtime })

  const coordinatorWorktreeId = await resolveDispatchCallerWorktreeId(runtime, params.from)
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
      coordinatorPane,
      resolvedWorktreeId: resolvedWorktree?.id
    })
  }
  const mode = await resolveWorkerStartModeOnHost(runtime, args.mode, resolvedWorktree?.id, agent)

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
    creator: resolveDispatchCreator(runtime, params.from),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    taskId: existingTask?.id,
    taskSpec: params.spec,
    taskTitle: params.taskTitle,
    taskDeps: parseTaskDeps(params.deps),
    taskParentId: params.parent,
    taskRunId: run.id,
    taskCreatedByTerminalHandle: params.from,
    taskCreatedByPaneKey: coordinatorPane ?? undefined,
    taskCreatedByProcessIncarnation:
      runtime.getTerminalProcessIncarnation(params.from) ?? undefined,
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
  let structuredSession: Awaited<
    ReturnType<typeof createStructuredWorkerSessionForWorktree>
  > | null = null
  let terminalRevealWarning: string | undefined
  let failedStage = 'terminal_create'
  let setupReceipt: WorkerSetupReceipt = {
    requested: 'not_applicable',
    effective: 'not_applicable',
    source: 'existing_worktree',
    hookFound: false,
    startupPolicy: 'start-immediately',
    state: 'not_applicable'
  }
  try {
    if (creationWorktree) {
      failedStage = 'worktree_create'
      const created = await createWorkerWorktree({
        runtime,
        db,
        dispatchId: started.dispatch.id,
        requestedWorktree,
        coordinatorWorktree: creationWorktree,
        params,
        agent: agent as TuiAgent,
        launchPreferences: launch.preferences,
        effects
      })
      resolvedWorktree = created.worktree
      terminalHandle = created.terminalHandle
      setupReceipt = created.setupReceipt
    } else if (!terminalHandle && mode.mode === 'structured') {
      db.recordWorkerStage({
        dispatchId: started.dispatch.id,
        stage: 'terminal_creating',
        worktreeId: resolvedWorktree!.id,
        effects
      })
      structuredSession = await createStructuredWorkerSessionForWorktree({
        runtime,
        worktreeId: resolvedWorktree!.id,
        agent: agent as TuiAgent,
        dispatchId: started.dispatch.id,
        effects
      })
      terminalHandle = structuredSession.identity.handle
    } else if (!terminalHandle) {
      db.recordWorkerStage({
        dispatchId: started.dispatch.id,
        stage: 'terminal_creating',
        worktreeId: resolvedWorktree!.id,
        effects
      })
      const terminal = await createExistingWorktreeWorkerTerminal({
        runtime,
        worktreeId: resolvedWorktree!.id,
        agent: agent as TuiAgent,
        launchPreferences: launch.preferences,
        taskId: task.id,
        effects
      })
      terminalHandle = terminal.handle
      terminalRevealWarning = terminal.warning
    } else {
      effects.push({ kind: 'terminal', role: 'agent', action: 'reused', id: terminalHandle })
    }
    if (!resolvedWorktree || !terminalHandle) {
      throw new Error('Worker topology did not resolve an agent terminal and worktree.')
    }
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
    // A structured session is ready the moment its attach returns ok: there is no boot-to-idle
    // gap and no terminal title to read an idle edge from.
    if (!structuredSession) {
      const wait = await runtime.waitForTerminal(terminalHandle, {
        condition: 'tui-idle',
        timeoutMs: params.timeoutMs ?? 60_000
      })
      persistWorkerSetupWaitOutcome({ ...setupStage, wait })
      if (!wait.satisfied) {
        if (setupReceipt.state === 'failed') {
          failedStage = 'setup_wait'
        }
        throw new Error(
          wait.blockedReason
            ? `Agent startup blocked: ${wait.blockedReason}`
            : `Agent did not become ready (${wait.status}).`
        )
      }
    }
    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId: resolvedWorktree.id,
      effects,
      setupState: setupReceipt.state,
      terminalOwnership: params.terminal ? 'external' : 'created'
    })

    failedStage = 'dispatch_input'
    const promptDelivery = await deliverWorkerDispatchPreamble({
      runtime,
      structuredSession,
      terminalHandle,
      dispatchId: started.dispatch.id,
      dispatchDepth: started.dispatch.depth,
      taskId: task.id,
      taskSpec: task.spec,
      coordinatorHandle: params.from,
      dispatchCapability: capability,
      devMode: params.devMode,
      requestId: orchestrationMutation?.requestId ?? started.dispatch.id
    })
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'accepted'
    })
    const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
    monitorWorkerSetup({
      runtime,
      db,
      runId: run.id,
      dispatchId: started.dispatch.id,
      setupReceipt,
      effects
    })
    return {
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      state: worker.state,
      stage: worker.stage,
      setup: setupReceipt,
      launch: launch.receipt,
      mode,
      timeoutMs: params.timeoutMs ?? 60_000,
      effects,
      ...(promptDelivery ? { prompt: promptDelivery } : {}),
      residualResources: [],
      ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
    }
  } catch (error) {
    await tearDownFailedWorkerStart({
      runtime,
      structuredSession,
      dispatchId: started.dispatch.id
    })
    return failWorkerStartWithReceipt({
      db,
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: setupReceipt,
      launch: launch.receipt,
      mode
    })
  }
}
