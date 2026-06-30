import type { PipelineRun, PipelineTask } from '../../shared/pipelines-types'
import type { PipelineRuntimeWorktreeInput } from './runtime-executor'

export function getLatestIterationTasks(
  db: { getRunDetail(runId: string): { tasks: PipelineTask[] } | undefined },
  runId: string,
  iterationId: string
): PipelineTask[] {
  return (db.getRunDetail(runId)?.tasks ?? []).filter((task) => task.iterationId === iterationId)
}

export function resolveWorktreePath(
  worktreeId: string,
  worktreePathById: Map<string, string>
): string {
  const path = worktreePathById.get(worktreeId)
  if (!path) {
    throw new Error(`Pipeline worktree path not found: ${worktreeId}`)
  }
  return path
}

export function buildCoordinatorSpec(run: PipelineRun, iterationNumber: number): string {
  return [`Pipeline run: ${run.id}`, `Iteration: ${iterationNumber}`].join('\n')
}

export function buildCoordinatorHandle(run: PipelineRun, iterationNumber: number): string {
  return `pipeline-${run.id}-iter-${iterationNumber}`
}

export function buildPlannerWorktreeInput(
  run: PipelineRun,
  iterationNumber: number
): PipelineRuntimeWorktreeInput {
  return {
    repoSelector: run.repoId,
    name: `Pipeline planner ${iterationNumber}`,
    baseBranch: run.sourceBranch,
    branchNameOverride: `pipeline/${run.id}/planner-${iterationNumber}`,
    comment: `Pipeline planner worktree for run ${run.id}, iteration ${iterationNumber}`,
    displayName: `Pipeline planner ${iterationNumber}`,
    telemetrySource: 'pipeline',
    workspaceStatus: 'in-progress'
  }
}

export function buildMergeWorktreeInput(
  run: PipelineRun,
  iterationNumber: number
): PipelineRuntimeWorktreeInput {
  return {
    repoSelector: run.repoId,
    name: `Pipeline merge ${iterationNumber}`,
    baseBranch: run.sourceBranch,
    branchNameOverride: `pipeline/${run.id}/merge-${iterationNumber}`,
    comment: `Pipeline merge worktree for run ${run.id}, iteration ${iterationNumber}`,
    displayName: `Pipeline merge ${iterationNumber}`,
    telemetrySource: 'pipeline',
    workspaceStatus: 'in-progress'
  }
}

export function buildReviewPrompt(branch: string): string {
  return `Review the Pipeline task branch ${branch}. Commit any review fixes if needed.`
}

export function buildMergePrompt(branches: string[]): string {
  return `Merge these Pipeline task branches into the current merge worktree:\n${branches.join('\n')}`
}
