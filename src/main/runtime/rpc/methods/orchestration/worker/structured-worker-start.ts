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
import { placeWorkerAgent, EXISTING_WORKTREE_SETUP } from './worker-start-agent-placement'
import { awaitStructuredWorkerSetupGate } from './worker-start-structured-setup-gate'
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
import { recordCreatedWorkerTerminalCustody } from './created-worker-terminal-custody'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import { requireWorkerAuthority, type WorkerEffect } from './worker-topology'
import { prepareLocalWorkerStart } from './worker-start-validation'
import { deliverAndSettleWorkerStartReadiness } from './worker-start-readiness-settlement'
import type { DurableWorkerMutationIdentity } from '../../orchestration-worker-terminal-lease-types'

export async function startStructuredWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  coordinatorPane: string | null
  existingTask?: TaskRow
  orchestrationMutation?: DurableWorkerMutationIdentity
  recordMutationReceipt?: (receipt: unknown) => void
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
  const resolvedWorktree = creationWorktree
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
  let placed: Awaited<ReturnType<typeof placeWorkerAgent>> | undefined
  let failedStage = 'terminal_create'
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
      agent: agent as TuiAgent,
      launchPreferences: launch.preferences,
      effects,
      onStage: (stage) => {
        failedStage = stage
      }
    })
    mode = placed.mode
    const terminalHandle = placed.terminalHandle
    const setupReceipt = placed.setupReceipt
    const setupStage = {
      db,
      dispatchId: started.dispatch.id,
      worktreeId: placed.worktree.id,
      terminalHandle,
      setup: setupReceipt,
      effects
    }
    recordCreatedWorkerTerminalCustody(
      runtime,
      setupStage,
      !params.terminal && !placed.structuredSession
    )
    if (persistGatedSetupSpawnFailure(setupStage)) {
      failedStage = 'setup_start'
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    persistWorkerReadinessStage(setupStage)
    failedStage = 'agent_readiness'
    const wait = placed.structuredSession
      ? await awaitStructuredWorkerSetupGate({
          runtime,
          setup: setupReceipt,
          effects,
          timeoutMs: params.timeoutMs ?? 60_000
        })
      : await runtime.waitForTerminal(terminalHandle, {
          condition: 'tui-idle',
          timeoutMs: params.timeoutMs ?? 60_000
        })
    if (wait) {
      persistWorkerSetupWaitOutcome({ ...setupStage, wait })
      if (!wait.satisfied) {
        if (setupReceipt.state === 'failed') {
          failedStage = 'setup_wait'
        }
        throw new Error(
          wait.blockedReason
            ? `Agent startup blocked: ${wait.blockedReason}`
            : placed.structuredSession
              ? `Setup did not finish before the structured worker started (${wait.status}).`
              : `Agent did not become ready (${wait.status}).`
        )
      }
    }
    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId: placed.worktree.id,
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
      structuredSession: placed.structuredSession,
      terminalHandle,
      coordinatorHandle: params.from,
      dispatchCapability: capability,
      devMode: params.devMode,
      requestId: orchestrationMutation?.requestId ?? started.dispatch.id,
      agent: agent ?? null,
      setupReceipt,
      launchReceipt: launch.receipt,
      mode,
      timeoutMs: params.timeoutMs ?? 60_000,
      effects,
      terminalRevealWarning: placed.warning,
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
