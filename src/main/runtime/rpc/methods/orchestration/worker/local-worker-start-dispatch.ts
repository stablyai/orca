import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import type { OrchestrationWorkerLaunchReceipt } from './worker-launch-preferences'
import type { WorkerStartInput } from './worker-start-schema'
import type { RunRow } from '../../../../orchestration/types'
import type { startLocalWorker } from './local-worker-start'
import { resolveDispatchCreator } from '../runs/dispatch-creator'

export function createLocalWorkerStartDispatch(
  {
    runtime,
    db,
    taskDeps,
    coordinator,
    callerSession,
    existingTask,
    orchestrationMutation,
    helperCreator
  }: Parameters<typeof startLocalWorker>[0],
  {
    params,
    run,
    requestedWorktree,
    createsWorktree,
    mode,
    resolvedWorktreeId,
    repoSelector,
    agent,
    launchReceipt
  }: {
    params: WorkerStartInput
    run: RunRow
    requestedWorktree: string
    createsWorktree: boolean
    mode: WorkerStartModeReceipt
    resolvedWorktreeId: string | undefined
    repoSelector: string | undefined
    agent: TuiAgent | undefined
    launchReceipt: OrchestrationWorkerLaunchReceipt
  }
) {
  const startOptions = {
    worktree: requestedWorktree,
    mode,
    resolvedWorktreeId: resolvedWorktreeId ?? null,
    name: params.name ?? null,
    repo: repoSelector ?? params.repo ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: agent ?? null,
    launch: launchReceipt,
    timeoutMs: params.timeoutMs ?? 60_000,
    setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: createsWorktree
      ? params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
  return db.createStartingWorkerDispatch({
    creator: resolveDispatchCreator(runtime, params.from, callerSession),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    requiredCreatorDispatchId: helperCreator?.id,
    taskId: existingTask?.id,
    taskSpec: params.spec,
    taskTitle: params.taskTitle,
    taskDeps,
    // A helper's Task sits under its creator's Task, so the Run's Task tree shows who started it.
    taskParentId: params.parent ?? helperCreator?.task_id,
    taskRunId: run.id,
    // A handle-less session creates root Tasks: Task lineage is recorded by terminal only.
    taskCreatedByTerminalHandle: coordinator?.terminalHandle ?? undefined,
    taskCreatedByPaneKey: coordinator?.paneKey ?? undefined,
    taskCreatedByProcessIncarnation: coordinator?.terminalHandle
      ? (runtime.getTerminalProcessIncarnation(coordinator.terminalHandle) ?? undefined)
      : undefined,
    taskCreatedByRunGeneration: run.consumer_generation,
    retryOf: params.retryOf,
    startOptions,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation
  })
}
