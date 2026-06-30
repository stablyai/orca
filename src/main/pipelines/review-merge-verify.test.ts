import { afterEach, describe, expect, it } from 'vitest'
import { PipelineDb } from './db'
import { runPipelineReviewMergeVerifyStages } from './review-merge-verify'
import type { PipelineRunInput } from '../../shared/pipelines-types'

describe('runPipelineReviewMergeVerifyStages', () => {
  let db: PipelineDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): PipelineDb {
    db = new PipelineDb(':memory:')
    return db
  }

  function input(): PipelineRunInput {
    return {
      templateId: 'parallel-planner-with-review',
      repoId: 'repo_orca',
      sourceBranch: 'main',
      targetBranch: 'pipeline-output',
      taskSource: { type: 'manual', tasks: [] },
      maxConcurrent: 2,
      maxIterations: 2,
      plannerAgentId: 'codex',
      implementerAgentId: 'codex',
      reviewerAgentId: 'codex',
      mergerAgentId: 'codex',
      verifier: { commands: ['pnpm test --filter pipeline'], timeoutSeconds: 60 },
      executionTargetType: 'local'
    }
  }

  function githubInput(): PipelineRunInput {
    return {
      ...input(),
      taskSource: {
        type: 'github_issues',
        provider: 'github',
        owner: 'Nikolatesla-lj',
        repo: 'orca',
        prdIssueNumber: 13,
        pipelinePrdLabel: 'pipeline:prd-13',
        state: 'open'
      }
    }
  }

  it('reviews only tasks with commits and verifies the merge worktree', async () => {
    const d = createDb()
    const run = d.createRun(input())
    const iteration = d.createIteration({ runId: run.id, iterationNumber: 1 })
    const taskWithCommits = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'manual',
      sourceId: 'manual-1',
      title: 'Task with commits',
      branch: 'pipeline/manual-1',
      worktreeId: 'wt_task_1'
    })
    const taskWithoutCommits = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'manual',
      sourceId: 'manual-2',
      title: 'Task without commits',
      branch: 'pipeline/manual-2',
      worktreeId: 'wt_task_2'
    })
    const reviewCalls: unknown[] = []
    const mergeCalls: unknown[] = []

    const result = await runPipelineReviewMergeVerifyStages({
      db: d,
      run,
      iteration,
      tasks: [taskWithCommits, taskWithoutCommits],
      templateId: run.templateId,
      resolveWorktreePath: (worktreeId) => `/repo/${worktreeId}`,
      inspectCommits: async ({ branch }) => ({
        commitShas: branch === 'pipeline/manual-1' ? ['impl_sha', 'review_sha'] : []
      }),
      reviewerRunner: async (input) => {
        reviewCalls.push(input)
        return { terminalId: 'term_review_1', stdout: '<promise>COMPLETE</promise>' }
      },
      mergeWorktreeCreator: async () => ({ worktreeId: 'wt_merge_1', path: '/repo/merge' }),
      mergerRunner: async (input) => {
        mergeCalls.push(input)
        return { terminalId: 'term_merge_1', stdout: '<promise>COMPLETE</promise>' }
      },
      verifyCommandRunner: async ({ command }) => ({
        command,
        exitCode: 0,
        timedOut: false,
        stdout: 'ok',
        stderr: ''
      })
    })

    expect(reviewCalls).toMatchObject([
      { taskId: taskWithCommits.id, worktreeId: 'wt_task_1', branch: 'pipeline/manual-1' }
    ])
    expect(mergeCalls).toMatchObject([
      { branches: ['pipeline/manual-1'], worktreeId: 'wt_merge_1' }
    ])
    expect(result.mergedBranches).toEqual(['pipeline/manual-1'])
    expect(d.getTask(taskWithCommits.id)).toMatchObject({
      status: 'verified',
      commitShas: ['impl_sha', 'review_sha']
    })
    expect(d.getTask(taskWithoutCommits.id)).toMatchObject({
      status: 'no_changes',
      commitShas: []
    })
    expect(d.getRunDetail(run.id)?.logs.map((log) => log.message)).toEqual(
      expect.arrayContaining([
        'Pipeline run status changed to merging',
        'Pipeline run status changed to verifying',
        'Pipeline run status changed to completed'
      ])
    )
    expect(d.getRunDetail(run.id)?.dynamicContextResults).toMatchObject([
      {
        command: 'pnpm test --filter pipeline',
        cwd: '/repo/merge',
        exitCode: 0,
        stdout: 'ok'
      }
    ])
  })

  it('fails verify while preserving merge worktree and command logs', async () => {
    const d = createDb()
    const run = d.createRun(input())
    const iteration = d.createIteration({ runId: run.id, iterationNumber: 1 })
    const task = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'manual',
      sourceId: 'manual-1',
      title: 'Task with commits',
      branch: 'pipeline/manual-1',
      worktreeId: 'wt_task_1'
    })

    await expect(
      runPipelineReviewMergeVerifyStages({
        db: d,
        run,
        iteration,
        tasks: [task],
        templateId: run.templateId,
        resolveWorktreePath: (worktreeId) => `/repo/${worktreeId}`,
        inspectCommits: async () => ({ commitShas: ['impl_sha'] }),
        reviewerRunner: async () => ({ stdout: '<promise>COMPLETE</promise>' }),
        mergeWorktreeCreator: async () => ({ worktreeId: 'wt_merge_1', path: '/repo/merge' }),
        mergerRunner: async () => ({ stdout: '<promise>COMPLETE</promise>' }),
        verifyCommandRunner: async ({ command }) => ({
          command,
          exitCode: 1,
          timedOut: false,
          stdout: 'failed',
          stderr: 'boom'
        })
      })
    ).rejects.toThrow('Pipeline verify command failed')

    const detail = d.getRunDetail(run.id)
    expect(detail?.stages.find((stage) => stage.stage === 'verify')).toMatchObject({
      status: 'failed',
      worktreeId: 'wt_merge_1'
    })
    expect(detail?.dynamicContextResults).toMatchObject([
      { command: 'pnpm test --filter pipeline', exitCode: 1, stdout: 'failed', stderr: 'boom' }
    ])
    expect(d.getRun(run.id)?.status).toBe('failed')
  })

  it('fails merge while preserving the merge worktree stage output', async () => {
    const d = createDb()
    const run = d.createRun(input())
    const iteration = d.createIteration({ runId: run.id, iterationNumber: 1 })
    const task = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'manual',
      sourceId: 'manual-1',
      title: 'Task with commits',
      branch: 'pipeline/manual-1',
      worktreeId: 'wt_task_1'
    })

    await expect(
      runPipelineReviewMergeVerifyStages({
        db: d,
        run,
        iteration,
        tasks: [task],
        templateId: run.templateId,
        resolveWorktreePath: (worktreeId) => `/repo/${worktreeId}`,
        inspectCommits: async () => ({ commitShas: ['impl_sha'] }),
        reviewerRunner: async () => ({ stdout: '<promise>COMPLETE</promise>' }),
        mergeWorktreeCreator: async () => ({ worktreeId: 'wt_merge_1', path: '/repo/merge' }),
        mergerRunner: async () => {
          throw new Error('merge conflict')
        },
        verifyCommandRunner: async ({ command }) => ({
          command,
          exitCode: 0,
          timedOut: false,
          stdout: 'ok',
          stderr: ''
        })
      })
    ).rejects.toThrow('merge conflict')

    const detail = d.getRunDetail(run.id)
    expect(detail?.stages.find((stage) => stage.stage === 'merge')).toMatchObject({
      status: 'failed',
      worktreeId: 'wt_merge_1',
      error: { message: 'merge conflict' }
    })
    expect(detail?.stages.some((stage) => stage.stage === 'verify')).toBe(false)
    expect(d.getRun(run.id)?.status).toBe('failed')
  })

  it('fails the closure gate when a merged GitHub task issue remains open', async () => {
    const d = createDb()
    const run = d.createRun(githubInput())
    const iteration = d.createIteration({ runId: run.id, iterationNumber: 1 })
    const task = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'github_issue',
      sourceId: '16',
      title: 'Task with commits',
      branch: 'pipeline/issue-16',
      worktreeId: 'wt_task_1'
    })

    await expect(
      runPipelineReviewMergeVerifyStages({
        db: d,
        run,
        iteration,
        tasks: [task],
        templateId: run.templateId,
        resolveWorktreePath: (worktreeId) => `/repo/${worktreeId}`,
        inspectCommits: async () => ({ commitShas: ['impl_sha'] }),
        reviewerRunner: async () => ({ stdout: '<promise>COMPLETE</promise>' }),
        mergeWorktreeCreator: async () => ({ worktreeId: 'wt_merge_1', path: '/repo/merge' }),
        mergerRunner: async () => ({ stdout: '<promise>COMPLETE</promise>' }),
        verifyCommandRunner: async ({ command }) => ({
          command,
          exitCode: 0,
          timedOut: false,
          stdout: 'ok',
          stderr: ''
        }),
        issueStateReader: async () => ({ state: 'open', url: 'https://github.com/i/16' })
      })
    ).rejects.toThrow('Pipeline task issue #16 remains open')

    expect(d.getTask(task.id)).toMatchObject({
      status: 'failed',
      issueClosure: { state: 'open', url: 'https://github.com/i/16' }
    })
    expect(d.getRun(run.id)?.status).toBe('failed')
  })
})
