import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { PipelineDb } from './db'
import { createPipelineRuntimeExecutor } from './runtime-executor'
import { PipelineService } from './service'
import type { PipelineRunInput } from '../../shared/pipelines-types'

describe('createPipelineRuntimeExecutor', () => {
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
      maxIterations: 2,
      plannerAgentId: 'codex',
      implementerAgentId: 'codex',
      reviewerAgentId: 'codex',
      mergerAgentId: 'codex',
      verifier: { commands: ['node --version'], timeoutSeconds: 30 },
      executionTargetType: 'local'
    }
  }

  it('runs planner, orchestration, review, merge, and verify through runtime adapters', async () => {
    pipelineDb = new PipelineDb(':memory:')
    orchestrationDb = new OrchestrationDb(':memory:')
    const createdWorktrees: { id: string; path: string }[] = []
    const terminalRuns: { agentId: string; stage: string; worktreeId: string; prompt: string }[] =
      []
    const workerTerminals: { agentId: string; worktreeId: string; title: string }[] = []
    let observedWorkerExecutionContext:
      | ReturnType<OrchestrationDb['getTaskExecutionContext']>
      | undefined
    let plannerCallCount = 0

    const service = new PipelineService({
      db: pipelineDb,
      executor: createPipelineRuntimeExecutor({
        orchestrationDb,
        runtime: {
          createWorktree: async (input) => {
            const worktree = {
              id: `wt_${createdWorktrees.length + 1}`,
              path: `/repo/${input.branchNameOverride}`
            }
            createdWorktrees.push(worktree)
            return worktree
          },
          runAgent: async (input) => {
            terminalRuns.push(input)
            if (input.stage === 'planner') {
              plannerCallCount += 1
              if (plannerCallCount === 2) {
                return { terminalId: 'term_planner_2', stdout: '<plan>{"issues":[]}</plan>' }
              }
              return {
                terminalId: 'term_planner_1',
                stdout:
                  '<plan>{"issues":[{"id":"16","title":"Implement runner","branch":"pipeline/issue-16"}]}</plan>'
              }
            }
            return { terminalId: `term_${input.stage}`, stdout: '<promise>COMPLETE</promise>' }
          },
          createAgentTerminal: async (input) => {
            workerTerminals.push(input)
            return { terminalId: 'term_worker_1' }
          },
          runCoordinator: async ({ db, coordinatorHandle }) => {
            const readyTasks = db.listTasks({ ready: true })
            expect(readyTasks).toHaveLength(1)
            observedWorkerExecutionContext = db.getTaskExecutionContext(readyTasks[0].id)
            for (const task of readyTasks) {
              db.createDispatchContext(task.id, `${coordinatorHandle}_worker`)
              db.updateTaskStatus(task.id, 'completed', JSON.stringify({ filesModified: [] }))
            }
            return { status: 'completed', completedTaskIds: db.listTasks().map((task) => task.id) }
          },
          inspectCommits: async () => ({ commitShas: ['impl_sha'] }),
          runCommand: async ({ command }) => {
            if (command.includes('issue view 13')) {
              return {
                command,
                exitCode: 0,
                timedOut: false,
                stdout: JSON.stringify({
                  number: 13,
                  title: 'Pipeline PRD',
                  state: 'OPEN',
                  url: 'https://github.com/Nikolatesla-lj/orca/issues/13'
                }),
                stderr: ''
              }
            }
            if (command.includes('issue view 16')) {
              return {
                command,
                exitCode: 0,
                timedOut: false,
                stdout: JSON.stringify({
                  state: 'CLOSED',
                  url: 'https://github.com/Nikolatesla-lj/orca/issues/16'
                }),
                stderr: ''
              }
            }
            if (command.includes('issue list')) {
              return {
                command,
                exitCode: 0,
                timedOut: false,
                stdout: JSON.stringify([
                  {
                    number: 16,
                    title: 'Implement runner',
                    body: '## Parent\n\n- PRD issue: #13\n\nWire stages.',
                    state: 'OPEN',
                    url: 'https://github.com/Nikolatesla-lj/orca/issues/16',
                    labels: [
                      { name: 'task-slice' },
                      { name: 'ready-for-agent' },
                      { name: 'pipeline:prd-13' }
                    ]
                  }
                ]),
                stderr: ''
              }
            }
            return {
              command,
              exitCode: 0,
              timedOut: false,
              stdout: 'v20.0.0',
              stderr: ''
            }
          }
        }
      })
    })

    const { run } = service.run(runInput())
    await service.waitForRunExecution(run.id)

    const detail = service.show(run.id)
    expect(detail.run.status).toBe('completed')
    expect(createdWorktrees.map((worktree) => worktree.id)).toEqual([
      'wt_1',
      'wt_2',
      'wt_3',
      'wt_4'
    ])
    expect(terminalRuns.map((call) => call.stage)).toEqual([
      'planner',
      'review',
      'merge',
      'planner'
    ])
    expect(workerTerminals).toEqual([
      { agentId: 'codex', worktreeId: 'wt_2', title: 'Implement runner' }
    ])
    expect(observedWorkerExecutionContext).toMatchObject({
      worktreeSelector: 'id:wt_2',
      preferredTerminalHandle: 'term_worker_1',
      title: 'Implement runner'
    })
    expect(terminalRuns[0]).toMatchObject({ agentId: 'codex', worktreeId: 'wt_1' })
    expect(detail.iterations).toEqual([
      expect.objectContaining({
        iterationNumber: 1,
        coordinatorRunId: expect.stringMatching(/^run_/),
        plannerTerminalId: 'term_planner_1',
        plannerWorktreeId: 'wt_1',
        status: 'completed'
      }),
      expect.objectContaining({
        iterationNumber: 2,
        plannerTerminalId: 'term_planner_2',
        plannerWorktreeId: 'wt_4',
        status: 'completed'
      })
    ])
    expect(detail.tasks).toEqual([
      expect.objectContaining({
        sourceId: '16',
        worktreeId: 'wt_2',
        status: 'verified',
        commitShas: ['impl_sha']
      })
    ])
    expect(detail.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'planner', status: 'completed' }),
        expect.objectContaining({
          stage: 'implement',
          status: 'completed',
          terminalId: 'term_worker_1',
          worktreeId: 'wt_2'
        }),
        expect.objectContaining({
          stage: 'review',
          status: 'completed',
          terminalId: 'term_review'
        }),
        expect.objectContaining({ stage: 'merge', status: 'completed', terminalId: 'term_merge' }),
        expect.objectContaining({ stage: 'verify', status: 'completed' })
      ])
    )
    expect(detail.dynamicContextResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'node --version', stdout: 'v20.0.0' })
      ])
    )
  })

  it('cancels with prd_closed when the parent PRD closes before dispatch', async () => {
    pipelineDb = new PipelineDb(':memory:')
    orchestrationDb = new OrchestrationDb(':memory:')
    let prdLookupCount = 0
    const workerTerminals: unknown[] = []
    const service = new PipelineService({
      db: pipelineDb,
      executor: createPipelineRuntimeExecutor({
        orchestrationDb,
        runtime: {
          createWorktree: async (input) => ({
            id: `wt_${input.branchNameOverride.replaceAll('/', '_')}`,
            path: `/repo/${input.branchNameOverride}`
          }),
          runAgent: async () => ({
            terminalId: 'term_planner_1',
            stdout:
              '<plan>{"issues":[{"id":"16","title":"Implement runner","branch":"pipeline/issue-16"}]}</plan>'
          }),
          createAgentTerminal: async (input) => {
            workerTerminals.push(input)
            return { terminalId: 'term_worker_1' }
          },
          runCoordinator: async () => ({ status: 'completed', completedTaskIds: [] }),
          inspectCommits: async () => ({ commitShas: [] }),
          runCommand: async ({ command }) => {
            if (command.includes('issue view 13')) {
              prdLookupCount += 1
              return {
                command,
                exitCode: 0,
                timedOut: false,
                stdout: JSON.stringify({
                  number: 13,
                  title: 'Pipeline PRD',
                  state: prdLookupCount < 3 ? 'OPEN' : 'CLOSED',
                  url: 'https://github.com/Nikolatesla-lj/orca/issues/13'
                }),
                stderr: ''
              }
            }
            return {
              command,
              exitCode: 0,
              timedOut: false,
              stdout: JSON.stringify([
                {
                  number: 16,
                  title: 'Implement runner',
                  body: '## Parent\n\n- PRD issue: #13',
                  state: 'OPEN',
                  url: 'https://github.com/Nikolatesla-lj/orca/issues/16',
                  labels: [
                    { name: 'task-slice' },
                    { name: 'ready-for-agent' },
                    { name: 'pipeline:prd-13' }
                  ]
                }
              ]),
              stderr: ''
            }
          }
        }
      })
    })

    const { run } = service.run(runInput())
    await service.waitForRunExecution(run.id)

    expect(workerTerminals).toEqual([])
    expect(service.show(run.id).run).toMatchObject({
      status: 'cancelled',
      statusReason: 'prd_closed'
    })
  })
})
