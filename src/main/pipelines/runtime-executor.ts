import type { OrchestrationDb } from '../runtime/orchestration/db'
import { bridgePipelineTasksToOrchestration } from './orchestration-bridge'
import { ensureParentPrdOpen } from './prd-open-checkpoint'
import { runPipelineReviewMergeVerifyStages } from './review-merge-verify'
import { runPipelineIterationLoop } from './iteration-loop'
import { runPipelinePlannerStage } from './planner-stage'
import {
  createImplementStages,
  updateImplementStagesAfterCoordinator
} from './runtime-executor-implement-stages'
import {
  buildCoordinatorHandle,
  buildCoordinatorSpec,
  buildMergePrompt,
  buildMergeWorktreeInput,
  buildPlannerWorktreeInput,
  buildReviewPrompt,
  getLatestIterationTasks,
  resolveWorktreePath
} from './runtime-executor-stage-inputs'
import type {
  PipelineRuntimeExecutorAdapter,
  PipelineRuntimeWorktree,
  PipelineRuntimeWorktreeInput
} from './runtime-executor-types'
import type { PipelineRunExecutor } from './service'

export type {
  PipelineRuntimeAgentInput,
  PipelineRuntimeExecutorAdapter,
  PipelineRuntimeWorktreeInput
} from './runtime-executor-types'

export function createPipelineRuntimeExecutor(input: {
  orchestrationDb: OrchestrationDb
  runtime: PipelineRuntimeExecutorAdapter
}): PipelineRunExecutor {
  return async ({ db, templates, run }) => {
    const template = templates.getTemplate(run.templateId)
    if (!template) {
      throw new Error(`Pipeline template not found: ${run.templateId}`)
    }
    const worktreePathById = new Map<string, string>()
    const createWorktree = async (
      worktreeInput: PipelineRuntimeWorktreeInput
    ): Promise<PipelineRuntimeWorktree> => {
      const worktree = await input.runtime.createWorktree(worktreeInput)
      worktreePathById.set(worktree.id, worktree.path)
      return worktree
    }

    const loop = await runPipelineIterationLoop({
      maxIterations: run.maxIterations,
      runIteration: async (iterationNumber) => {
        if (!(await ensureParentPrdOpen({ db, run, runtime: input.runtime, cwd: process.cwd() }))) {
          return { status: 'cancelled', plannedTaskCount: 0, completedTaskCount: 0 }
        }
        const coordinatorRun = input.orchestrationDb.createCoordinatorRun({
          spec: buildCoordinatorSpec(run, iterationNumber),
          coordinatorHandle: buildCoordinatorHandle(run, iterationNumber),
          pollIntervalMs: 500
        })
        const plannerWorktree = await createWorktree(
          buildPlannerWorktreeInput(run, iterationNumber)
        )
        const planned = await runPipelinePlannerStage({
          db,
          run: db.getRun(run.id) ?? run,
          template,
          cwd: plannerWorktree.path,
          iterationNumber,
          coordinatorRunId: coordinatorRun.id,
          taskSourceCommandRunner: async ({ command }) => {
            const result = await input.runtime.runCommand({
              command,
              cwd: plannerWorktree.path,
              timeoutSeconds: 60
            })
            if (result.timedOut || result.exitCode !== 0) {
              throw new Error(`Pipeline task source command failed: ${command}`)
            }
            return result.stdout
          },
          dynamicContextCommandRunner: async (commandInput) => {
            const result = await input.runtime.runCommand({
              command: commandInput.command,
              cwd: commandInput.cwd,
              timeoutSeconds: Math.ceil(commandInput.timeoutMs / 1000)
            })
            return {
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr
            }
          },
          plannerRunner: async (plannerInput) => {
            const result = await input.runtime.runAgent({
              agentId: run.plannerAgentId,
              stage: 'planner',
              run,
              iteration: plannerInput.iteration,
              template,
              worktreeId: plannerWorktree.id,
              cwd: plannerWorktree.path,
              prompt: plannerInput.prompt,
              title: `Pipeline planner ${iterationNumber}`
            })
            return { ...result, worktreeId: plannerWorktree.id }
          }
        })

        if (planned.tasks.length === 0) {
          return { status: 'completed', plannedTaskCount: 0, completedTaskCount: 0 }
        }
        if (
          !(await ensureParentPrdOpen({
            db,
            run,
            runtime: input.runtime,
            cwd: plannerWorktree.path
          }))
        ) {
          return {
            status: 'cancelled',
            plannedTaskCount: planned.tasks.length,
            completedTaskCount: 0
          }
        }

        db.updateRunStatus(run.id, 'dispatching')
        db.updateIterationStatus(planned.iteration.id, 'executing')
        await bridgePipelineTasksToOrchestration({
          pipelineDb: db,
          orchestrationDb: input.orchestrationDb,
          run,
          iteration: planned.iteration,
          tasks: planned.tasks,
          coordinatorRunId: coordinatorRun.id,
          coordinatorHandle: coordinatorRun.coordinator_handle,
          worktreeCreator: async (worktreeInput) => ({
            worktree: await createWorktree(worktreeInput)
          })
        })

        const bridgedTasks = getLatestIterationTasks(db, run.id, planned.iteration.id)
        const implementStages = await createImplementStages({
          db,
          orchestrationDb: input.orchestrationDb,
          run,
          iteration: planned.iteration,
          tasks: bridgedTasks,
          agentId: run.implementerAgentId,
          runtime: input.runtime
        })

        const coordinator = await input.runtime.runCoordinator({
          db: input.orchestrationDb,
          coordinatorRunId: coordinatorRun.id,
          coordinatorHandle: coordinatorRun.coordinator_handle,
          maxConcurrent: run.maxConcurrent
        })
        if (coordinator.status !== 'completed') {
          const error = {
            message: `Pipeline coordinator ${coordinator.status}`,
            details: {
              completedTaskIds: coordinator.completedTaskIds,
              failedTaskIds: coordinator.failedTaskIds ?? []
            }
          }
          db.updateIterationStatus(planned.iteration.id, 'failed', error)
          db.updateRunStatus(run.id, 'failed', error)
          updateImplementStagesAfterCoordinator(db, implementStages, coordinator.completedTaskIds)
          return {
            status: 'failed',
            plannedTaskCount: planned.tasks.length,
            completedTaskCount: coordinator.completedTaskIds.length
          }
        }
        updateImplementStagesAfterCoordinator(db, implementStages, coordinator.completedTaskIds)

        if (
          !(await ensureParentPrdOpen({
            db,
            run,
            runtime: input.runtime,
            cwd: plannerWorktree.path
          }))
        ) {
          return {
            status: 'cancelled',
            plannedTaskCount: planned.tasks.length,
            completedTaskCount: coordinator.completedTaskIds.length
          }
        }

        db.updateRunStatus(run.id, 'reviewing')
        db.updateIterationStatus(planned.iteration.id, 'reviewing')
        const latestTasks = getLatestIterationTasks(db, run.id, planned.iteration.id)
        const result = await runPipelineReviewMergeVerifyStages({
          db,
          run,
          iteration: planned.iteration,
          tasks: latestTasks,
          templateId: template.id,
          resolveWorktreePath: (worktreeId) => resolveWorktreePath(worktreeId, worktreePathById),
          inspectCommits: input.runtime.inspectCommits,
          reviewerRunner: async (reviewInput) =>
            input.runtime.runAgent({
              agentId: run.reviewerAgentId ?? run.implementerAgentId,
              stage: 'review',
              run,
              iteration: planned.iteration,
              template,
              worktreeId: reviewInput.worktreeId,
              cwd: reviewInput.cwd,
              prompt: buildReviewPrompt(reviewInput.branch),
              title: `Pipeline review ${reviewInput.branch}`
            }),
          mergeWorktreeCreator: async () => {
            const worktree = await createWorktree(buildMergeWorktreeInput(run, iterationNumber))
            return { worktreeId: worktree.id, path: worktree.path }
          },
          mergerRunner: async (mergeInput) =>
            input.runtime.runAgent({
              agentId: run.mergerAgentId,
              stage: 'merge',
              run,
              iteration: planned.iteration,
              template,
              worktreeId: mergeInput.worktreeId,
              cwd: mergeInput.cwd,
              prompt: buildMergePrompt(mergeInput.branches),
              title: `Pipeline merge ${iterationNumber}`
            }),
          verifyCommandRunner: input.runtime.runCommand
        })

        return {
          status: 'completed',
          plannedTaskCount: planned.tasks.length,
          completedTaskCount: result.reviewedTaskIds.length
        }
      }
    })

    db.appendLog({
      runId: run.id,
      message: `Pipeline iteration loop stopped: ${loop.stopReason}`,
      payload: loop
    })
    if (loop.stopReason !== 'failed' && loop.stopReason !== 'cancelled') {
      db.updateRunStatus(run.id, 'completed')
    }
  }
}
