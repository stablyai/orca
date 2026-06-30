import type { PipelineIteration, PipelineRun, PipelineTask } from '../../shared/pipelines-types'
import type { PipelineDb } from './db'
import { runIssueClosureGate, type PipelineIssueStateReader } from './issue-closure-gate'
import {
  PipelineReviewMergeVerifyError,
  toPipelineReviewMergeVerifyError
} from './review-merge-verify-errors'
import {
  type PipelineBranchCommitInspectionResult,
  inspectPipelineBranchCommits
} from './git-commit-inspector'
import { runDynamicContextCommand } from './dynamic-context-command-runner'

export type PipelineCommitInspector = (input: {
  cwd: string
  baseRef: string
  branch: string
  task: PipelineTask
}) => Promise<PipelineBranchCommitInspectionResult>

export type PipelineReviewerRunner = (input: {
  taskId: string
  worktreeId: string
  cwd: string
  branch: string
}) => Promise<{ terminalId?: string | null; stdout: string }>

export type PipelineMergerRunner = (input: {
  worktreeId: string
  cwd: string
  branches: string[]
}) => Promise<{ terminalId?: string | null; stdout: string }>

export type PipelineVerifyCommandResult = {
  command: string
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export type PipelineVerifyCommandRunner = (input: {
  command: string
  cwd: string
  timeoutSeconds: number
}) => Promise<PipelineVerifyCommandResult>

export type RunPipelineReviewMergeVerifyStagesInput = {
  db: PipelineDb
  run: PipelineRun
  iteration: PipelineIteration
  tasks: PipelineTask[]
  templateId: string
  resolveWorktreePath: (worktreeId: string) => string
  inspectCommits?: PipelineCommitInspector
  reviewerRunner: PipelineReviewerRunner
  mergeWorktreeCreator: () => Promise<{ worktreeId: string; path: string }>
  mergerRunner: PipelineMergerRunner
  verifyCommandRunner?: PipelineVerifyCommandRunner
  issueStateReader?: PipelineIssueStateReader
}

export type RunPipelineReviewMergeVerifyStagesResult = {
  reviewedTaskIds: string[]
  mergedBranches: string[]
  mergeWorktreeId: string | null
}

export async function runPipelineReviewMergeVerifyStages(
  input: RunPipelineReviewMergeVerifyStagesInput
): Promise<RunPipelineReviewMergeVerifyStagesResult> {
  const reviewedTasks = await runReviewStages(input)
  if (reviewedTasks.length === 0) {
    return { reviewedTaskIds: [], mergedBranches: [], mergeWorktreeId: null }
  }

  input.db.updateRunStatus(input.run.id, 'merging')
  input.db.updateIterationStatus(input.iteration.id, 'merging')
  const mergeWorktree = await input.mergeWorktreeCreator()
  const branches = reviewedTasks.map((task) => task.branch)
  const mergeStage = input.db.createStage({
    runId: input.run.id,
    iterationId: input.iteration.id,
    stage: 'merge',
    status: 'running',
    worktreeId: mergeWorktree.worktreeId
  })

  try {
    const mergeResult = await input.mergerRunner({
      worktreeId: mergeWorktree.worktreeId,
      cwd: mergeWorktree.path,
      branches
    })
    input.db.updateStageExecutionRefs(mergeStage.id, {
      terminalId: mergeResult.terminalId,
      worktreeId: mergeWorktree.worktreeId
    })
    input.db.updateStageStatus(mergeStage.id, 'completed', {
      outputSnapshot: mergeResult.stdout
    })
  } catch (error) {
    input.db.updateStageStatus(mergeStage.id, 'failed', {
      error: toPipelineReviewMergeVerifyError(error)
    })
    input.db.updateIterationStatus(
      input.iteration.id,
      'failed',
      toPipelineReviewMergeVerifyError(error)
    )
    input.db.updateRunStatus(input.run.id, 'failed', toPipelineReviewMergeVerifyError(error))
    throw error
  }

  for (const task of reviewedTasks) {
    input.db.updateTaskStatus(task.id, 'merged')
  }

  input.db.updateRunStatus(input.run.id, 'verifying')
  input.db.updateIterationStatus(input.iteration.id, 'verifying')
  try {
    await runVerifyStage(input, mergeWorktree)
    await runIssueClosureGate({
      db: input.db,
      run: input.run,
      tasks: reviewedTasks,
      cwd: mergeWorktree.path,
      issueStateReader: input.issueStateReader,
      verifyCommandRunner: input.verifyCommandRunner
    })
  } catch (error) {
    input.db.updateIterationStatus(
      input.iteration.id,
      'failed',
      toPipelineReviewMergeVerifyError(error)
    )
    input.db.updateRunStatus(input.run.id, 'failed', toPipelineReviewMergeVerifyError(error))
    throw error
  }

  for (const task of reviewedTasks) {
    input.db.updateTaskStatus(task.id, 'verified')
  }
  input.db.updateIterationStatus(input.iteration.id, 'completed')
  input.db.updateRunStatus(input.run.id, 'completed')

  return {
    reviewedTaskIds: reviewedTasks.map((task) => task.id),
    mergedBranches: branches,
    mergeWorktreeId: mergeWorktree.worktreeId
  }
}

async function runReviewStages(
  input: RunPipelineReviewMergeVerifyStagesInput
): Promise<PipelineTask[]> {
  const inspectCommits = input.inspectCommits ?? defaultInspectCommits
  const reviewedTasks: PipelineTask[] = []

  for (const task of input.tasks) {
    const worktreePath = getTaskWorktreePath(input, task)
    const beforeReview = await inspectCommits({
      cwd: worktreePath,
      baseRef: input.run.sourceBranch,
      branch: task.branch,
      task
    })
    input.db.updateTaskCommitShas(task.id, { commitShas: beforeReview.commitShas })
    if (beforeReview.commitShas.length === 0) {
      input.db.createStage({
        runId: input.run.id,
        iterationId: input.iteration.id,
        taskId: task.id,
        stage: 'review',
        status: 'skipped',
        worktreeId: task.worktreeId
      })
      input.db.updateTaskStatus(task.id, 'no_changes')
      continue
    }

    input.db.updateTaskStatus(task.id, 'implemented')
    const reviewStage = input.db.createStage({
      runId: input.run.id,
      iterationId: input.iteration.id,
      taskId: task.id,
      stage: 'review',
      status: 'running',
      worktreeId: task.worktreeId
    })
    const reviewResult = await input.reviewerRunner({
      taskId: task.id,
      worktreeId: task.worktreeId!,
      cwd: worktreePath,
      branch: task.branch
    })
    input.db.updateStageExecutionRefs(reviewStage.id, {
      terminalId: reviewResult.terminalId,
      worktreeId: task.worktreeId
    })
    const afterReview = await inspectCommits({
      cwd: worktreePath,
      baseRef: input.run.sourceBranch,
      branch: task.branch,
      task
    })
    input.db.updateTaskCommitShas(task.id, { commitShas: afterReview.commitShas })
    input.db.updateStageStatus(reviewStage.id, 'completed', {
      outputSnapshot: reviewResult.stdout
    })
    input.db.updateTaskStatus(task.id, 'reviewed')
    reviewedTasks.push(input.db.getTask(task.id) ?? task)
  }

  return reviewedTasks
}

async function runVerifyStage(
  input: RunPipelineReviewMergeVerifyStagesInput,
  mergeWorktree: { worktreeId: string; path: string }
): Promise<void> {
  const verifyStage = input.db.createStage({
    runId: input.run.id,
    iterationId: input.iteration.id,
    stage: 'verify',
    status: 'running',
    worktreeId: mergeWorktree.worktreeId
  })
  const commands = input.run.verifier?.commands ?? []
  try {
    for (const command of commands) {
      const result = await runVerifyCommand(input, command, mergeWorktree.path)
      input.db.recordDynamicContextResult({
        runId: input.run.id,
        stageId: verifyStage.id,
        templateId: input.templateId,
        command,
        cwd: mergeWorktree.path,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: false,
        stderrTruncated: false
      })
      if (result.timedOut || result.exitCode !== 0) {
        throw new PipelineReviewMergeVerifyError(
          'verify_failed',
          `Pipeline verify command failed: ${command}`,
          { command, exitCode: result.exitCode, timedOut: result.timedOut }
        )
      }
    }
  } catch (error) {
    input.db.updateStageStatus(verifyStage.id, 'failed', {
      error: toPipelineReviewMergeVerifyError(error)
    })
    throw error
  }
  input.db.updateStageStatus(verifyStage.id, 'completed', {
    outputSnapshot: commands.join('\n')
  })
}

async function runVerifyCommand(
  input: RunPipelineReviewMergeVerifyStagesInput,
  command: string,
  cwd: string
): Promise<PipelineVerifyCommandResult> {
  if (input.verifyCommandRunner) {
    return input.verifyCommandRunner({
      command,
      cwd,
      timeoutSeconds: input.run.verifier?.timeoutSeconds ?? 60
    })
  }
  const result = await runDynamicContextCommand({
    command,
    cwd,
    timeoutMs: (input.run.verifier?.timeoutSeconds ?? 60) * 1000,
    maxStdoutChars: 32_000,
    maxStderrChars: 8_000
  })
  return { command, ...result }
}

async function defaultInspectCommits(input: {
  cwd: string
  baseRef: string
  branch: string
}): Promise<PipelineBranchCommitInspectionResult> {
  return inspectPipelineBranchCommits(input)
}

function getTaskWorktreePath(
  input: RunPipelineReviewMergeVerifyStagesInput,
  task: PipelineTask
): string {
  if (!task.worktreeId) {
    throw new PipelineReviewMergeVerifyError(
      'missing_task_worktree',
      `Pipeline task ${task.id} has no worktree id`,
      { taskId: task.id }
    )
  }
  return input.resolveWorktreePath(task.worktreeId)
}
