import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { OrchestrationTaskExecutionContext, TaskRow } from '../runtime/orchestration/types'
import type { PipelineDb } from './db'
import type { PipelineIteration, PipelineRun, PipelineTask } from '../../shared/pipelines-types'

export type PipelineBridgeWorktreeCreateInput = {
  repoSelector: string
  name: string
  baseBranch: string
  branchNameOverride: string
  linkedIssue?: number | null
  comment: string
  displayName: string
  telemetrySource: 'pipeline'
  workspaceStatus: string
  lineage?: {
    orchestrationContext?: {
      orchestrationRunId?: string
      coordinatorHandle?: string
    }
  }
}

export type PipelineBridgeWorktreeCreateResult = {
  worktree: { id: string }
}

export type PipelineBridgeMapping = {
  pipelineTaskId: string
  orchestrationTaskId: string
  worktreeId: string
}

export type BridgePipelineTasksToOrchestrationInput = {
  pipelineDb: PipelineDb
  orchestrationDb: OrchestrationDb
  run: PipelineRun
  iteration: PipelineIteration
  tasks: PipelineTask[]
  coordinatorRunId?: string
  coordinatorHandle?: string
  worktreeCreator: (
    input: PipelineBridgeWorktreeCreateInput
  ) => Promise<PipelineBridgeWorktreeCreateResult>
}

export class PipelineOrchestrationBridgeError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PipelineOrchestrationBridgeError'
    this.code = code
    this.details = details
  }
}

export async function bridgePipelineTasksToOrchestration(
  input: BridgePipelineTasksToOrchestrationInput
): Promise<{ mappings: PipelineBridgeMapping[]; orchestrationTasks: TaskRow[] }> {
  const sortedTasks = sortTasksByPlannerDependencies(input.tasks)
  const orchestrationTaskIdBySourceId = new Map<string, string>()
  const mappings: PipelineBridgeMapping[] = []
  const orchestrationTasks: TaskRow[] = []

  for (const task of sortedTasks) {
    const worktree = await input.worktreeCreator(buildWorktreeCreateInput(input, task))
    const deps = task.blockedBy.map((sourceId) => {
      const orchestrationTaskId = orchestrationTaskIdBySourceId.get(sourceId)
      if (!orchestrationTaskId) {
        throw new PipelineOrchestrationBridgeError(
          'missing_dependency',
          `Pipeline task ${task.id} depends on unavailable source task ${sourceId}`,
          { pipelineTaskId: task.id, sourceId }
        )
      }
      return orchestrationTaskId
    })
    const orchestrationTask = input.orchestrationDb.createTask({
      spec: buildOrchestrationTaskSpec(task),
      deps,
      executionContext: buildExecutionContext(task, worktree.worktree.id)
    })
    input.pipelineDb.updateTaskDispatchLink(task.id, {
      orchestrationTaskId: orchestrationTask.id,
      worktreeId: worktree.worktree.id
    })

    orchestrationTaskIdBySourceId.set(task.sourceId, orchestrationTask.id)
    orchestrationTasks.push(orchestrationTask)
    mappings.push({
      pipelineTaskId: task.id,
      orchestrationTaskId: orchestrationTask.id,
      worktreeId: worktree.worktree.id
    })
  }

  return { mappings, orchestrationTasks }
}

function buildWorktreeCreateInput(
  input: BridgePipelineTasksToOrchestrationInput,
  task: PipelineTask
): PipelineBridgeWorktreeCreateInput {
  return {
    repoSelector: input.run.repoId,
    name: task.title,
    baseBranch: input.run.sourceBranch,
    branchNameOverride: task.branch,
    linkedIssue: getLinkedGitHubIssue(task),
    comment: buildWorktreeComment(input.run, input.iteration, task),
    displayName: task.title,
    telemetrySource: 'pipeline',
    workspaceStatus: 'in-progress',
    lineage: {
      orchestrationContext: {
        orchestrationRunId: input.coordinatorRunId,
        coordinatorHandle: input.coordinatorHandle
      }
    }
  }
}

function buildExecutionContext(
  task: PipelineTask,
  worktreeId: string
): OrchestrationTaskExecutionContext {
  return {
    worktreeSelector: `id:${worktreeId}`,
    title: task.title
  }
}

function buildOrchestrationTaskSpec(task: PipelineTask): string {
  return [
    `Title: ${task.title}`,
    `Source: ${task.sourceType}:${task.sourceId}`,
    `Branch: ${task.branch}`,
    '',
    'Implement this task in the assigned worktree.'
  ].join('\n')
}

function buildWorktreeComment(
  run: PipelineRun,
  iteration: PipelineIteration,
  task: PipelineTask
): string {
  return [
    `Pipeline run: ${run.id}`,
    `Pipeline iteration: ${iteration.id}`,
    `Pipeline task: ${task.id}`,
    `Source: ${task.sourceType}:${task.sourceId}`
  ].join('\n')
}

function getLinkedGitHubIssue(task: PipelineTask): number | null {
  if (task.sourceType !== 'github_issue') {
    return null
  }
  const issueNumber = Number(task.sourceId)
  return Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null
}

function sortTasksByPlannerDependencies(tasks: PipelineTask[]): PipelineTask[] {
  const taskBySourceId = new Map<string, PipelineTask>()
  for (const task of tasks) {
    if (taskBySourceId.has(task.sourceId)) {
      throw new PipelineOrchestrationBridgeError(
        'duplicate_source_task',
        `Duplicate Pipeline source task in one bridge call: ${task.sourceId}`,
        { sourceId: task.sourceId }
      )
    }
    taskBySourceId.set(task.sourceId, task)
  }

  const sorted: PipelineTask[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  for (const task of tasks) {
    visitTask(task, { taskBySourceId, visiting, visited, sorted })
  }
  return sorted
}

function visitTask(
  task: PipelineTask,
  state: {
    taskBySourceId: Map<string, PipelineTask>
    visiting: Set<string>
    visited: Set<string>
    sorted: PipelineTask[]
  }
): void {
  if (state.visited.has(task.sourceId)) {
    return
  }
  if (state.visiting.has(task.sourceId)) {
    throw new PipelineOrchestrationBridgeError(
      'dependency_cycle',
      `Pipeline task dependency cycle at source task ${task.sourceId}`,
      { sourceId: task.sourceId }
    )
  }

  state.visiting.add(task.sourceId)
  for (const blockerSourceId of task.blockedBy) {
    const blocker = state.taskBySourceId.get(blockerSourceId)
    if (!blocker) {
      throw new PipelineOrchestrationBridgeError(
        'missing_dependency',
        `Pipeline task ${task.id} depends on unavailable source task ${blockerSourceId}`,
        { pipelineTaskId: task.id, sourceId: blockerSourceId }
      )
    }
    visitTask(blocker, state)
  }
  state.visiting.delete(task.sourceId)
  state.visited.add(task.sourceId)
  state.sorted.push(task)
}
