import type { PipelinePlannerOutputV1 } from '../../shared/pipeline-template-types'
import type { PipelineRun, PipelineIteration, PipelineTask } from '../../shared/pipelines-types'
import type { PipelineDb } from './db'
import type { PipelineSourceTask } from './task-source'

export class PipelinePlannerStageError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PipelinePlannerStageError'
    this.code = code
    this.details = details
  }
}

export function createPipelineTasksFromPlannerOutput(input: {
  db: PipelineDb
  run: PipelineRun
  iteration: PipelineIteration
  sourceTasks: PipelineSourceTask[]
  plannerOutput: PipelinePlannerOutputV1
}): PipelineTask[] {
  const taskInputs = validatePlannedIssues(input.sourceTasks, input.plannerOutput.issues)
  return taskInputs.map((taskInput) =>
    input.db.createTask({
      runId: input.run.id,
      iterationId: input.iteration.id,
      sourceType: taskInput.sourceTask.sourceType,
      sourceId: taskInput.sourceTask.sourceId,
      title: taskInput.title,
      branch: taskInput.branch,
      blockedBy: taskInput.blockedBy
    })
  )
}

function validatePlannedIssues(
  sourceTasks: PipelineSourceTask[],
  plannedIssues: { id: string; title: string; branch: string; blockedBy?: string[] }[]
): {
  sourceTask: PipelineSourceTask
  title: string
  branch: string
  blockedBy: string[]
}[] {
  const sourceById = new Map(sourceTasks.map((task) => [task.sourceId, task]))
  const sourceIdByBranch = new Map<string, string>()
  const seenSourceIds = new Set<string>()
  const taskInputs: {
    sourceTask: PipelineSourceTask
    title: string
    branch: string
    blockedBy: string[]
  }[] = []

  for (const issue of plannedIssues) {
    const sourceTask = sourceById.get(issue.id)
    if (!sourceTask) {
      throw new PipelinePlannerStageError(
        'unknown_source_task',
        `Pipeline planner referenced an unknown task source id: ${issue.id}`,
        { sourceId: issue.id }
      )
    }
    if (seenSourceIds.has(issue.id)) {
      throw new PipelinePlannerStageError(
        'duplicate_source_task',
        `Pipeline planner returned the same task source id twice: ${issue.id}`,
        { sourceId: issue.id }
      )
    }

    const branch = normalizePlannerBranch(issue.branch)
    const existingSourceId = sourceIdByBranch.get(branch)
    if (existingSourceId && existingSourceId !== issue.id) {
      throw new PipelinePlannerStageError(
        'branch_collision',
        `Pipeline planner branch collision: ${branch}`,
        { branch, firstSourceId: existingSourceId, secondSourceId: issue.id }
      )
    }

    seenSourceIds.add(issue.id)
    sourceIdByBranch.set(branch, issue.id)
    taskInputs.push({
      sourceTask,
      title: issue.title,
      branch,
      blockedBy: issue.blockedBy ?? []
    })
  }

  return taskInputs
}

function normalizePlannerBranch(branch: string): string {
  const normalized = branch.trim()
  if (!normalized) {
    throw new PipelinePlannerStageError('empty_branch', 'Pipeline planner returned an empty branch')
  }
  return normalized
}
