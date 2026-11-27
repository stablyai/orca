import type {
  WorktreeLineageInput,
  WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'

type Lineage = Extract<WorktreeLineageResolution, { kind: 'lineage' }>

/** A worker's create names its parent outright; its Task makes the link the worker's, which is how a bot's workspaces are told apart. */
export function workerCreatedLineage(input: WorktreeLineageInput, explicit: Lineage): Lineage {
  const context = input.orchestrationContext
  if (!context?.taskId) {
    return explicit
  }
  return {
    kind: 'lineage',
    parent: explicit.parent,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    taskId: context.taskId,
    ...(context.orchestrationRunId ? { orchestrationRunId: context.orchestrationRunId } : {}),
    ...(context.coordinatorHandle ? { coordinatorHandle: context.coordinatorHandle } : {}),
    ...(input.callerTerminalHandle ? { createdByTerminalHandle: input.callerTerminalHandle } : {})
  }
}
