import type { PipelineDb } from './db'
import type { PipelineRuntimeExecutorAdapter } from './runtime-executor'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { PipelineIteration, PipelineRun, PipelineTask } from '../../shared/pipelines-types'
import type { TuiAgent } from '../../shared/types'

type PipelineImplementStageDb = Pick<
  PipelineDb,
  'createStage' | 'updateStageStatus' | 'updateTaskStatus'
>

export type PipelineImplementStageRecord = {
  stageId: string
  taskId: string
  orchestrationTaskId: string | null
}

export async function createImplementStages(input: {
  db: PipelineImplementStageDb
  orchestrationDb: Pick<OrchestrationDb, 'updateTaskExecutionContext'>
  run: PipelineRun
  iteration: PipelineIteration
  tasks: PipelineTask[]
  agentId: TuiAgent
  runtime: Pick<PipelineRuntimeExecutorAdapter, 'createAgentTerminal'>
}): Promise<PipelineImplementStageRecord[]> {
  const stages: PipelineImplementStageRecord[] = []
  for (const task of input.tasks) {
    if (!task.worktreeId) {
      throw new Error(`Pipeline task ${task.id} has no worktree id`)
    }
    const terminal = await input.runtime.createAgentTerminal({
      agentId: input.agentId,
      worktreeId: task.worktreeId,
      title: task.title
    })
    if (task.orchestrationTaskId && terminal.terminalId) {
      input.orchestrationDb.updateTaskExecutionContext(task.orchestrationTaskId, {
        preferredTerminalHandle: terminal.terminalId
      })
    }
    const stage = input.db.createStage({
      runId: input.run.id,
      iterationId: input.iteration.id,
      taskId: task.id,
      stage: 'implement',
      status: 'running',
      worktreeId: task.worktreeId,
      terminalId: terminal.terminalId
    })
    input.db.updateTaskStatus(task.id, 'dispatched')
    stages.push({
      stageId: stage.id,
      taskId: task.id,
      orchestrationTaskId: task.orchestrationTaskId
    })
  }
  return stages
}

export function updateImplementStagesAfterCoordinator(
  db: PipelineImplementStageDb,
  stages: PipelineImplementStageRecord[],
  completedOrchestrationTaskIds: string[]
): void {
  const completed = new Set(completedOrchestrationTaskIds)
  for (const stage of stages) {
    const ok = stage.orchestrationTaskId ? completed.has(stage.orchestrationTaskId) : false
    db.updateStageStatus(stage.stageId, ok ? 'completed' : 'failed')
    if (!ok) {
      db.updateTaskStatus(stage.taskId, 'failed', {
        message: 'Pipeline implement task did not complete'
      })
    }
  }
}
