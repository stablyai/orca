import { afterEach, describe, expect, it } from 'vitest'
import { PipelineDb } from './db'
import { createBuiltInPipelineTemplateRegistry } from './template-registry'
import { runPipelinePlannerStage } from './planner-stage'
import type { PipelineRunInput } from '../../shared/pipelines-types'

describe('runPipelinePlannerStage', () => {
  let db: PipelineDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): PipelineDb {
    db = new PipelineDb(':memory:')
    return db
  }

  function template() {
    const builtInTemplate = createBuiltInPipelineTemplateRegistry().getTemplate(
      'parallel-planner-with-review'
    )
    if (!builtInTemplate) {
      throw new Error('built-in Pipeline template missing')
    }
    return builtInTemplate
  }

  function input(taskSource: PipelineRunInput['taskSource']): PipelineRunInput {
    return {
      templateId: 'parallel-planner-with-review',
      repoId: 'repo_orca',
      sourceBranch: 'main',
      targetBranch: 'pipeline-output',
      taskSource,
      maxConcurrent: 2,
      maxIterations: 3,
      plannerAgentId: 'codex',
      implementerAgentId: 'codex',
      mergerAgentId: 'codex',
      executionTargetType: 'local'
    }
  }

  it('renders GitHub task source context and stores planned tasks', async () => {
    const d = createDb()
    const run = d.createRun(
      input({
        type: 'github_issues',
        provider: 'github',
        owner: 'Nikolatesla-lj',
        repo: 'orca',
        prdIssueNumber: 13,
        pipelinePrdLabel: 'pipeline:prd-13',
        state: 'open'
      })
    )
    const taskSourceCommands: string[] = []
    let plannerPrompt = ''

    const result = await runPipelinePlannerStage({
      db: d,
      run,
      template: template(),
      cwd: '/repo',
      taskSourceCommandRunner: async ({ command }) => {
        taskSourceCommands.push(command)
        if (command.includes('issue view 13')) {
          return JSON.stringify({
            number: 13,
            title: 'Pipeline PRD',
            state: 'OPEN',
            url: 'https://github.com/Nikolatesla-lj/orca/issues/13'
          })
        }
        return JSON.stringify([
          {
            number: 6,
            title: 'Implement planner stage',
            body: '## Parent\n\n- PRD issue: #13\n\nPlan ready tasks',
            state: 'OPEN',
            url: 'https://github.com/Nikolatesla-lj/orca/issues/6',
            labels: [
              { name: 'task-slice' },
              { name: 'ready-for-agent' },
              { name: 'pipeline:prd-13' }
            ]
          }
        ])
      },
      plannerRunner: async ({ prompt }) => {
        plannerPrompt = prompt
        return {
          stdout:
            '<plan>{"issues":[{"id":"6","title":"Implement planner stage","branch":"pipeline/issue-6"}]}</plan>',
          terminalId: 'term_plan',
          worktreeId: 'wt_plan'
        }
      }
    })

    expect(taskSourceCommands).toEqual([
      'gh issue view 13 --repo Nikolatesla-lj/orca --json number,title,state,url',
      'gh issue list --repo Nikolatesla-lj/orca --state open --limit 100 --label task-slice --label ready-for-agent --label pipeline:prd-13 --json number,title,body,state,url,labels'
    ])
    expect(plannerPrompt).toContain('Implement planner stage')
    expect(result.tasks).toMatchObject([
      { sourceType: 'github_issue', sourceId: '6', branch: 'pipeline/issue-6', status: 'planned' }
    ])

    const detail = d.getRunDetail(run.id)
    expect(detail?.iterations).toMatchObject([
      {
        status: 'completed',
        plannerTerminalId: 'term_plan',
        plannerWorktreeId: 'wt_plan',
        plannerOutput: { issues: [{ id: '6', branch: 'pipeline/issue-6' }] }
      }
    ])
    expect(detail?.stages.find((stage) => stage.stage === 'task_source')).toMatchObject({
      status: 'completed'
    })
    expect(detail?.stages.find((stage) => stage.stage === 'planner')).toMatchObject({
      status: 'completed',
      terminalId: 'term_plan',
      worktreeId: 'wt_plan'
    })
    expect(detail?.dynamicContextResults).toMatchObject([
      { command: expect.stringContaining('gh issue list'), exitCode: 0 }
    ])
  })

  it('exits cleanly when the task source is empty', async () => {
    const d = createDb()
    const run = d.createRun(input({ type: 'manual', tasks: [] }))

    const result = await runPipelinePlannerStage({
      db: d,
      run,
      template: template(),
      cwd: '/repo',
      taskSourceCommandRunner: async () => {
        throw new Error('manual source must not execute commands')
      },
      plannerRunner: async () => {
        throw new Error('planner must not run for an empty task source')
      }
    })

    expect(result.tasks).toEqual([])
    expect(d.getRun(run.id)?.status).toBe('completed')
    expect(d.getRunDetail(run.id)?.stages).toMatchObject([
      { stage: 'task_source', status: 'completed' }
    ])
  })

  it('fails planning before tasks are created when planner output is invalid', async () => {
    const d = createDb()
    const run = d.createRun(
      input({ type: 'manual', tasks: [{ id: 'manual-1', title: 'Task 1', body: 'Body' }] })
    )

    await expect(
      runPipelinePlannerStage({
        db: d,
        run,
        template: template(),
        cwd: '/repo',
        taskSourceCommandRunner: async () => {
          throw new Error('manual source must not execute commands')
        },
        plannerRunner: async () => ({
          stdout: 'missing structured output',
          terminalId: 'term_plan'
        })
      })
    ).rejects.toThrow('Structured output tag <plan> not found')

    const detail = d.getRunDetail(run.id)
    expect(detail?.tasks).toEqual([])
    expect(detail?.iterations).toMatchObject([{ status: 'failed' }])
    expect(detail?.stages.find((stage) => stage.stage === 'planner')).toMatchObject({
      status: 'failed',
      terminalId: 'term_plan'
    })
  })

  it('fails planning when two source tasks claim the same branch', async () => {
    const d = createDb()
    const run = d.createRun(
      input({
        type: 'manual',
        tasks: [
          { id: 'manual-1', title: 'Task 1', body: 'Body' },
          { id: 'manual-2', title: 'Task 2', body: 'Body' }
        ]
      })
    )

    await expect(
      runPipelinePlannerStage({
        db: d,
        run,
        template: template(),
        cwd: '/repo',
        taskSourceCommandRunner: async () => {
          throw new Error('manual source must not execute commands')
        },
        plannerRunner: async () => ({
          stdout:
            '<plan>{"issues":[{"id":"manual-1","title":"Task 1","branch":"pipeline/same"},{"id":"manual-2","title":"Task 2","branch":"pipeline/same"}]}</plan>'
        })
      })
    ).rejects.toThrow('Pipeline planner branch collision')

    const detail = d.getRunDetail(run.id)
    expect(detail?.tasks).toEqual([])
    expect(detail?.stages.find((stage) => stage.stage === 'planner')).toMatchObject({
      status: 'failed'
    })
  })
})
