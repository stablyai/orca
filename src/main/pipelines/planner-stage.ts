import type { PipelineTemplate } from '../../shared/pipeline-template-types'
import type {
  PipelineIteration,
  PipelineRun,
  PipelineStage,
  PipelineTask
} from '../../shared/pipelines-types'
import type { PipelineDb } from './db'
import { runDynamicContextCommand } from './dynamic-context-command-runner'
import type {
  PipelineDynamicContextCommandInput,
  PipelineDynamicContextCommandResult
} from './prompt-renderer'
import { renderPipelinePrompt } from './prompt-renderer'
import {
  PipelinePlannerStageError,
  createPipelineTasksFromPlannerOutput
} from './planner-task-records'
import { PipelineStructuredOutputError, extractPipelinePlannerOutput } from './structured-output'
import {
  type PipelineSourceTask,
  type PipelineTaskSourceCommandRunner,
  resolvePipelineTaskSource
} from './task-source'

export type PipelinePlannerRunnerInput = {
  prompt: string
  run: PipelineRun
  iteration: PipelineIteration
  stage: PipelineStage
  template: PipelineTemplate
}

export type PipelinePlannerRunnerResult = {
  stdout: string
  terminalId?: string | null
  worktreeId?: string | null
}

export type PipelinePlannerRunner = (
  input: PipelinePlannerRunnerInput
) => Promise<PipelinePlannerRunnerResult>

export type RunPipelinePlannerStageInput = {
  db: PipelineDb
  run: PipelineRun
  template: PipelineTemplate
  cwd: string
  iterationNumber?: number
  coordinatorRunId?: string | null
  taskSourceCommandRunner: PipelineTaskSourceCommandRunner
  dynamicContextCommandRunner?: (
    input: PipelineDynamicContextCommandInput
  ) => Promise<PipelineDynamicContextCommandResult>
  plannerRunner: PipelinePlannerRunner
}

export type RunPipelinePlannerStageResult = {
  iteration: PipelineIteration
  taskSourceStage: PipelineStage
  plannerStage: PipelineStage | null
  tasks: PipelineTask[]
}

export async function runPipelinePlannerStage(
  input: RunPipelinePlannerStageInput
): Promise<RunPipelinePlannerStageResult> {
  input.db.updateRunStatus(input.run.id, 'planning')
  const iteration = input.db.createIteration({
    runId: input.run.id,
    iterationNumber: input.iterationNumber ?? input.run.currentIteration + 1,
    status: 'planning',
    coordinatorRunId: input.coordinatorRunId
  })
  const taskSourceStage = input.db.createStage({
    runId: input.run.id,
    iterationId: iteration.id,
    stage: 'task_source',
    status: 'running'
  })

  const resolvedTaskSource = await resolveTaskSource(input, iteration, taskSourceStage)
  if (resolvedTaskSource.tasks.length === 0) {
    input.db.updateIterationStatus(iteration.id, 'completed')
    input.db.updateRunStatus(input.run.id, 'completed')
    return {
      iteration: input.db.getIteration(iteration.id) ?? iteration,
      taskSourceStage: input.db.getStage(taskSourceStage.id) ?? taskSourceStage,
      plannerStage: null,
      tasks: []
    }
  }

  const plannerStage = input.db.createStage({
    runId: input.run.id,
    iterationId: iteration.id,
    stage: 'planner',
    status: 'running'
  })

  try {
    const rendered = await renderPipelinePrompt({
      prompt: input.template.prompts.planner,
      builtInArgs: {
        SOURCE_BRANCH: input.run.sourceBranch,
        TARGET_BRANCH: input.run.targetBranch,
        LIST_TASKS_COMMAND: resolvedTaskSource.listTasksCommand
      },
      cwd: input.cwd,
      runId: input.run.id,
      stageId: plannerStage.id,
      templateId: input.template.id,
      db: input.db,
      commandRunner: createTaskSourceSnapshotRunner(
        resolvedTaskSource.listTasksCommand,
        resolvedTaskSource.tasks,
        input.dynamicContextCommandRunner ?? runDynamicContextCommand
      ),
      timeoutMs: input.template.safety.dynamicContextTimeoutMs,
      maxStdoutChars: input.template.safety.maxStdoutChars,
      maxStderrChars: input.template.safety.maxStderrChars
    })
    const plannerResult = await input.plannerRunner({
      prompt: rendered.prompt,
      run: input.run,
      iteration,
      stage: plannerStage,
      template: input.template
    })
    input.db.updateStageExecutionRefs(plannerStage.id, {
      terminalId: plannerResult.terminalId,
      worktreeId: plannerResult.worktreeId
    })
    input.db.updateIterationPlannerResult(iteration.id, {
      plannerTerminalId: plannerResult.terminalId,
      plannerWorktreeId: plannerResult.worktreeId
    })
    const plannerOutput = extractPipelinePlannerOutput(plannerResult.stdout, {
      runId: input.run.id,
      iterationId: iteration.id,
      stageId: plannerStage.id,
      terminalId: plannerResult.terminalId
    })
    const tasks = createPipelineTasksFromPlannerOutput({
      db: input.db,
      run: input.run,
      iteration,
      sourceTasks: resolvedTaskSource.tasks,
      plannerOutput
    })

    input.db.updateIterationPlannerResult(iteration.id, { plannerOutput })
    input.db.updateStageStatus(plannerStage.id, 'completed', {
      outputSnapshot: truncateSnapshot(plannerResult.stdout)
    })
    input.db.updateIterationStatus(iteration.id, 'completed')
    input.db.updateRunStatus(input.run.id, tasks.length > 0 ? 'dispatching' : 'completed')

    return {
      iteration: input.db.getIteration(iteration.id) ?? iteration,
      taskSourceStage: input.db.getStage(taskSourceStage.id) ?? taskSourceStage,
      plannerStage: input.db.getStage(plannerStage.id) ?? plannerStage,
      tasks
    }
  } catch (error) {
    input.db.updateStageStatus(plannerStage.id, 'failed', {
      error: serializePlannerStageError(error)
    })
    input.db.updateIterationStatus(iteration.id, 'failed', serializePlannerStageError(error))
    input.db.updateRunStatus(input.run.id, 'failed', serializePlannerStageError(error))
    throw error
  }
}

async function resolveTaskSource(
  input: RunPipelinePlannerStageInput,
  iteration: PipelineIteration,
  taskSourceStage: PipelineStage
): Promise<{
  tasks: PipelineSourceTask[]
  listTasksCommand: string
}> {
  try {
    const resolved = await resolvePipelineTaskSource({
      taskSource: input.run.taskSource,
      commandRunner: input.taskSourceCommandRunner
    })
    input.db.updateStageStatus(taskSourceStage.id, 'completed', {
      outputSnapshot: truncateSnapshot(
        JSON.stringify({ command: resolved.listTasksCommand, tasks: resolved.tasks }, null, 2)
      )
    })
    return {
      tasks: resolved.tasks,
      listTasksCommand: resolved.listTasksCommand
    }
  } catch (error) {
    input.db.updateStageStatus(taskSourceStage.id, 'failed', {
      error: serializePlannerStageError(error)
    })
    input.db.updateIterationStatus(iteration.id, 'failed', serializePlannerStageError(error))
    input.db.updateRunStatus(input.run.id, 'failed', serializePlannerStageError(error))
    throw error
  }
}

function createTaskSourceSnapshotRunner(
  listTasksCommand: string,
  tasks: PipelineSourceTask[],
  fallbackRunner: (
    input: PipelineDynamicContextCommandInput
  ) => Promise<PipelineDynamicContextCommandResult>
): (input: PipelineDynamicContextCommandInput) => Promise<PipelineDynamicContextCommandResult> {
  return async (input) => {
    if (input.command === listTasksCommand) {
      return {
        exitCode: 0,
        timedOut: false,
        stdout: JSON.stringify(tasks, null, 2),
        stderr: ''
      }
    }
    return fallbackRunner(input)
  }
}

function serializePlannerStageError(error: unknown): {
  message: string
  code?: string
  details?: unknown
} {
  if (error instanceof PipelinePlannerStageError) {
    return { message: error.message, code: error.code, details: error.details }
  }
  if (error instanceof PipelineStructuredOutputError) {
    return {
      message: error.message,
      code: error.failureKind,
      details: {
        tag: error.tag,
        rawOutputSummary: error.rawOutputSummary,
        terminalId: error.terminalId
      }
    }
  }
  if (error instanceof Error) {
    return { message: error.message }
  }
  return { message: String(error) }
}

function truncateSnapshot(text: string, limit = 32_000): string {
  return text.length > limit ? text.slice(0, limit) : text
}
