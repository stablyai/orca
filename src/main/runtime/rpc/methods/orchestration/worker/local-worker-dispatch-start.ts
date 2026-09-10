import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import type { WorkerStartInput } from './worker-start-schema'
import type { prepareLocalWorkerStartTopology } from './worker-start-validation'
import { parseTaskDeps } from './task-deps-argument'
import type { DurableWorkerMutationIdentity } from '../../orchestration-worker-terminal-lease-types'
import { resolveDispatchCreator } from '../runs/dispatch-creator'

export function beginLocalWorkerDispatch(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  coordinatorPane: string | null
  existingTask?: TaskRow
  orchestrationMutation?: DurableWorkerMutationIdentity
  prepared: Awaited<ReturnType<typeof prepareLocalWorkerStartTopology>>
  readinessTimeoutMs: number
}) {
  const {
    params,
    runtime,
    db,
    run,
    coordinatorPane,
    existingTask,
    orchestrationMutation,
    prepared,
    readinessTimeoutMs
  } = args
  const { requestedWorktree, resolvedWorktree, creationWorktree, createsWorktree, agent, launch } =
    prepared
  const startOptions = {
    worktree: requestedWorktree,
    resolvedWorktreeId: resolvedWorktree?.id ?? null,
    name: params.name ?? null,
    repo: params.repo ?? creationWorktree?.repoId ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: agent ?? null,
    replacementOf: params.replacementOf ?? null,
    launch: launch.receipt,
    timeoutMs: readinessTimeoutMs,
    setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: createsWorktree
      ? params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
  return db.createStartingWorkerDispatch({
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
    replacementOf: params.replacementOf,
    startOptions,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation
  })
}
