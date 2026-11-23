import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchModeReceipt as WorkerStartModeReceipt } from '../../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import {
  reusedWorkerLaunchReceipt,
  type OrchestrationWorkerLaunchReceipt
} from './launch/worker-launch-preferences'
import { resolveDispatchAssigneeParty } from '../../../../../orchestration/addressing/orchestration-party'
import type { WorkerStartInput } from './worker-start-input'
import type { RunRow } from '../../../../../orchestration/db/orchestration-records'
import type { startLocalWorker } from './local-worker-start'
import { resolveDispatchCreator } from '../../runs/dispatch-creator'

export function createLocalWorkerStartDispatch(
  {
    runtime,
    db,
    taskDeps,
    coordinator,
    callerSession,
    existingTask,
    orchestrationMutation,
    helperCreator,
    followUp,
    chatLineage
  }: Parameters<typeof startLocalWorker>[0],
  {
    params,
    run,
    requestedWorktree,
    createsWorktree,
    mode,
    resolvedWorktreeId,
    resolvedWorktreeInstanceId,
    repoSelector,
    agent,
    launchReceipt,
    takesMailMessageIds
  }: {
    params: WorkerStartInput
    run: RunRow
    requestedWorktree: string
    createsWorktree: boolean
    mode: WorkerStartModeReceipt
    resolvedWorktreeId: string | undefined
    resolvedWorktreeInstanceId?: string | undefined
    repoSelector: string | undefined
    agent: TuiAgent | undefined
    launchReceipt: OrchestrationWorkerLaunchReceipt
    takesMailMessageIds?: readonly string[]
  }
) {
  const startOptions = {
    worktree: requestedWorktree,
    mode,
    resolvedWorktreeId: resolvedWorktreeId ?? null,
    resolvedWorktreeInstanceId: resolvedWorktreeInstanceId ?? null,
    name: params.name ?? null,
    repo: repoSelector ?? params.repo ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: agent ?? null,
    // Mail from a reuse start that never binds still names the agent already running there.
    launch: params.terminal
      ? reusedWorkerLaunchReceipt(
          runtime,
          launchReceipt,
          resolveDispatchAssigneeParty(params.terminal, db)
        )
      : launchReceipt,
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
    adoptTaskId: params.adoptTaskId,
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
    mutationReceipt: orchestrationMutation,
    followUpOf: followUp?.of,
    acceptedBy: followUp?.acceptedBy,
    takesMailOf: followUp?.takesMailOf,
    ...(takesMailMessageIds !== undefined ? { takesMailMessageIds } : {}),
    ...(params.origin ? { originRef: params.origin } : {}),
    ...(params.forQuestion ? { forMessageId: params.forQuestion } : {}),
    ...(chatLineage ? { chatLineage } : {})
  })
}
