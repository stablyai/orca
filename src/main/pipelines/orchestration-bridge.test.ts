import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { PipelineDb } from './db'
import { bridgePipelineTasksToOrchestration } from './orchestration-bridge'
import type { PipelineRunInput } from '../../shared/pipelines-types'

describe('bridgePipelineTasksToOrchestration', () => {
  let pipelineDb: PipelineDb | undefined
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    pipelineDb?.close()
    orchestrationDb?.close()
    pipelineDb = undefined
    orchestrationDb = undefined
  })

  function runInput(): PipelineRunInput {
    return {
      templateId: 'parallel-planner-with-review',
      repoId: 'repo_orca',
      sourceBranch: 'main',
      targetBranch: 'pipeline-output',
      taskSource: {
        type: 'github_issues',
        provider: 'github',
        owner: 'Nikolatesla-lj',
        repo: 'orca',
        prdIssueNumber: 13,
        pipelinePrdLabel: 'pipeline:prd-13',
        state: 'open'
      },
      maxConcurrent: 2,
      maxIterations: 3,
      plannerAgentId: 'codex',
      implementerAgentId: 'codex',
      mergerAgentId: 'codex',
      executionTargetType: 'local'
    }
  }

  it('creates task worktrees, orchestration tasks, and pipeline mappings', async () => {
    pipelineDb = new PipelineDb(':memory:')
    orchestrationDb = new OrchestrationDb(':memory:')
    const run = pipelineDb.createRun(runInput())
    const iteration = pipelineDb.createIteration({ runId: run.id, iterationNumber: 1 })
    const parent = pipelineDb.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'github_issue',
      sourceId: '6',
      title: 'Add bridge',
      branch: 'pipeline/issue-6'
    })
    const child = pipelineDb.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'github_issue',
      sourceId: '7',
      title: 'Use bridge',
      branch: 'pipeline/issue-7',
      blockedBy: ['6']
    })
    const worktreeCalls: unknown[] = []

    const result = await bridgePipelineTasksToOrchestration({
      pipelineDb,
      orchestrationDb,
      run,
      iteration,
      tasks: [child, parent],
      coordinatorRunId: 'coord_run_1',
      coordinatorHandle: 'coord',
      worktreeCreator: async (input) => {
        worktreeCalls.push(input)
        return { worktree: { id: `wt_${worktreeCalls.length}` } }
      }
    })

    expect(worktreeCalls).toMatchObject([
      {
        repoSelector: 'repo_orca',
        baseBranch: 'main',
        branchNameOverride: 'pipeline/issue-6',
        linkedIssue: 6,
        displayName: 'Add bridge'
      },
      {
        repoSelector: 'repo_orca',
        baseBranch: 'main',
        branchNameOverride: 'pipeline/issue-7',
        linkedIssue: 7,
        displayName: 'Use bridge'
      }
    ])
    expect(result.mappings).toHaveLength(2)

    const orchestrationTasks = orchestrationDb.listTasks()
    expect(orchestrationTasks).toMatchObject([
      { spec: expect.stringContaining('Add bridge'), deps: '[]' },
      { spec: expect.stringContaining('Use bridge') }
    ])
    expect(JSON.parse(orchestrationTasks[1].deps)).toEqual([orchestrationTasks[0].id])
    expect(orchestrationDb.getTaskExecutionContext(orchestrationTasks[0].id)).toEqual({
      worktreeSelector: 'id:wt_1',
      title: 'Add bridge'
    })
    expect(orchestrationDb.getTaskExecutionContext(orchestrationTasks[1].id)).toEqual({
      worktreeSelector: 'id:wt_2',
      title: 'Use bridge'
    })

    const detail = pipelineDb.getRunDetail(run.id)
    expect(detail?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parent.id,
          orchestrationTaskId: orchestrationTasks[0].id,
          worktreeId: 'wt_1',
          status: 'worktree_created'
        }),
        expect.objectContaining({
          id: child.id,
          orchestrationTaskId: orchestrationTasks[1].id,
          worktreeId: 'wt_2',
          status: 'worktree_created'
        })
      ])
    )
  })
})
