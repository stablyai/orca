import type { OrcaRuntimeService } from '../../orca-runtime'
import type { CreateTaskInput } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RunRow } from '../../orchestration/types'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

// Why: builds the --spec task input without writing; the task row itself is created inside
// createStartingWorkerDispatch's transaction so a rejected or crashed acceptance rolls it back.
export function buildWorkerStartTaskInput(args: {
  runtime: OrcaRuntimeService
  params: WorkerStartInput
  run: RunRow
}): CreateTaskInput {
  const { runtime, params, run } = args
  // Why: WorkerStartParams.superRefine guarantees this, but spec feeds a NOT NULL column —
  // a direct runtime caller must fail as invalid_argument, not as a sqlite bind error.
  if (!params.spec) {
    throw new OrchestrationError(
      'invalid_argument',
      'worker-start requires --spec when --task is absent.'
    )
  }
  const creatorAuthority = runtime.getOrchestrationDispatchAuthority(params.from)
  return {
    spec: params.spec,
    taskTitle: params.taskTitle,
    createdByTerminalHandle: params.from,
    ...(creatorAuthority?.paneKey && creatorAuthority.processIncarnation
      ? {
          createdByPaneKey: creatorAuthority.paneKey,
          createdByProcessIncarnation: creatorAuthority.processIncarnation,
          createdByRunGeneration: run.consumer_generation
        }
      : {}),
    runId: run.id
  }
}
