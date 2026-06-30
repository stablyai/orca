import { afterEach, describe, expect, it } from 'vitest'
import { createBuiltInPipelineTemplateRegistry } from './template-registry'
import { runPipelinePlannerStage } from './planner-stage'
import { PipelineDb } from './db'
import { PipelineService } from './service'
import type { PipelineRunInput } from '../../shared/pipelines-types'

describe('PipelineService execution', () => {
  let db: PipelineDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
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
      maxIterations: 2,
      plannerAgentId: 'codex',
      implementerAgentId: 'codex',
      mergerAgentId: 'codex',
      executionTargetType: 'local'
    }
  }

  it('starts the configured executor after creating a run', async () => {
    db = new PipelineDb(':memory:')
    const templates = createBuiltInPipelineTemplateRegistry()
    const service = new PipelineService({
      db,
      templates,
      executor: async ({ run, db: pipelineDb, templates: registry }) => {
        const template = registry.getTemplate(run.templateId)
        if (!template) {
          throw new Error(`Missing template ${run.templateId}`)
        }
        await runPipelinePlannerStage({
          db: pipelineDb,
          run,
          template,
          cwd: process.cwd(),
          taskSourceCommandRunner: async ({ command }) => {
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
                number: 16,
                title: 'Add pipeline runner',
                body: '## Parent\n\n- PRD issue: #13\n\nWire run execution.',
                state: 'OPEN',
                url: 'https://github.com/Nikolatesla-lj/orca/issues/16',
                labels: [
                  { name: 'task-slice' },
                  { name: 'ready-for-agent' },
                  { name: 'pipeline:prd-13' }
                ]
              }
            ])
          },
          plannerRunner: async () => ({
            terminalId: 'term_plan',
            worktreeId: 'wt_plan',
            stdout:
              '<plan>{"issues":[{"id":"16","title":"Add pipeline runner","branch":"pipeline/issue-16"}]}</plan>'
          })
        })
      }
    })

    const { run } = service.run(runInput())
    await service.waitForRunExecution(run.id)

    const detail = service.show(run.id)
    expect(detail.run.status).toBe('dispatching')
    expect(detail.iterations).toEqual([
      expect.objectContaining({
        iterationNumber: 1,
        plannerTerminalId: 'term_plan',
        plannerWorktreeId: 'wt_plan'
      })
    ])
    expect(detail.tasks).toEqual([
      expect.objectContaining({
        sourceId: '16',
        branch: 'pipeline/issue-16',
        status: 'planned'
      })
    ])
    expect(detail.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'task_source', status: 'completed' }),
        expect.objectContaining({ stage: 'planner', status: 'completed' })
      ])
    )
  })

  it('records executor failures on the run and logs', async () => {
    db = new PipelineDb(':memory:')
    const service = new PipelineService({
      db,
      executor: async () => {
        throw new Error('Pipeline runner is unavailable')
      }
    })

    const { run } = service.run(runInput())
    await service.waitForRunExecution(run.id)

    const detail = service.show(run.id)
    expect(detail.run).toMatchObject({
      status: 'failed',
      error: { message: 'Pipeline runner is unavailable' }
    })
    expect(detail.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: 'Pipeline runner is unavailable'
        })
      ])
    )
  })

  it('reserves a PRD work set and releases it on cancellation', () => {
    db = new PipelineDb(':memory:')
    const service = new PipelineService({ db })

    const { run } = service.run(runInput())
    const reservation = db.getActiveRunReservation({
      repoId: 'repo_orca',
      providerOwner: 'Nikolatesla-lj',
      providerRepo: 'orca',
      prdIssueNumber: 13,
      pipelinePrdLabel: 'pipeline:prd-13'
    })

    expect(reservation).toMatchObject({ runId: run.id, status: 'active' })
    expect(() =>
      service.run({
        ...runInput(),
        executionTargetType: 'ssh',
        executionTargetId: 'ssh-dev'
      })
    ).toThrow('active Pipeline run reservation already exists')

    service.cancel(run.id)

    expect(
      db.getActiveRunReservation({
        repoId: 'repo_orca',
        providerOwner: 'Nikolatesla-lj',
        providerRepo: 'orca',
        prdIssueNumber: 13,
        pipelinePrdLabel: 'pipeline:prd-13'
      })
    ).toBeUndefined()
  })

  it('requires latest recovery acknowledgement before replacement launch', () => {
    db = new PipelineDb(':memory:')
    const service = new PipelineService({ db })
    const interrupted = db.createRun(runInput())
    db.updateRunStatus(interrupted.id, 'interrupted')
    const report = db.createRecoveryReport({
      interruptedRunId: interrupted.id,
      repoId: 'repo_orca',
      providerOwner: 'Nikolatesla-lj',
      providerRepo: 'orca',
      prdIssueNumber: 13,
      pipelinePrdLabel: 'pipeline:prd-13',
      summary: {
        completedTaskIssueNumbers: [],
        openReadyTaskIssueNumbers: [16],
        preservedWorktreeIds: [],
        dirtyWorktreeIds: [],
        liveTerminalIds: [],
        missingTerminalIds: []
      }
    })

    expect(() => service.run(runInput())).toThrow('pending recovery report')

    service.recoveryReportAcknowledge(report.id)
    const replacement = service.run(runInput(), { recoveryReportId: report.id }).run

    expect(replacement).toMatchObject({
      replacesRunId: interrupted.id,
      recoveryReportId: report.id
    })
    expect(db.getRecoveryReport(report.id)).toMatchObject({ replacementRunId: replacement.id })
    expect(db.getRun(interrupted.id)?.status).toBe('interrupted')
  })

  it('returns recent PRD candidates with ready counts and active reservation state', async () => {
    db = new PipelineDb(':memory:')
    const service = new PipelineService({
      db,
      githubCommandRunner: async ({ args }) => {
        if (args.includes('--label') && args.includes('prd')) {
          return JSON.stringify([
            {
              number: 13,
              title: '[PRD] Pipeline v1',
              state: 'OPEN',
              updatedAt: '2026-06-05T14:27:25Z'
            }
          ])
        }
        return JSON.stringify([
          {
            number: 16,
            title: 'Task slice',
            body: '## Parent\n\n- PRD issue: #13',
            state: 'OPEN',
            updatedAt: '2026-06-05T15:00:00Z',
            labels: [
              { name: 'task-slice' },
              { name: 'ready-for-agent' },
              { name: 'pipeline:prd-13' }
            ]
          }
        ])
      }
    })
    const { run } = service.run(runInput())

    const result = await service.prdCandidates({
      repoId: 'repo_orca',
      owner: 'Nikolatesla-lj',
      repo: 'orca',
      limit: 10
    })

    expect(result.candidates).toEqual([
      expect.objectContaining({
        provider: 'github',
        owner: 'Nikolatesla-lj',
        repo: 'orca',
        prdIssueNumber: 13,
        prdTitle: '[PRD] Pipeline v1',
        pipelinePrdLabel: 'pipeline:prd-13',
        readyTaskCount: 1,
        openTaskCount: 1,
        latestTaskUpdatedAt: '2026-06-05T15:00:00Z',
        latestPrdUpdatedAt: '2026-06-05T14:27:25Z',
        activeRunId: run.id
      })
    ])
  })
})
