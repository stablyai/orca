import { afterEach, describe, expect, it } from 'vitest'
import { buildRegistry, type RpcContext } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { PipelineDb } from '../../../pipelines/db'
import { PipelineService } from '../../../pipelines/service'
import { PIPELINE_METHODS } from './pipelines'
import type { PipelineRunInput } from '../../../../shared/pipelines-types'

type PipelineServiceOverrides = Omit<ConstructorParameters<typeof PipelineService>[0], 'db'>

describe('pipeline RPC methods', () => {
  let db: PipelineDb | undefined
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function setup(input: PipelineServiceOverrides = {}): PipelineService {
    db = new PipelineDb(':memory:')
    const service = new PipelineService({ ...input, db })
    runtime = new OrcaRuntimeService()
    runtime.setPipelineService(service)
    ctx = { runtime }
    return service
  }

  function findMethod(name: string) {
    const method = PIPELINE_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown> = {}) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

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

  it('registers expected Pipeline methods', () => {
    const registry = buildRegistry(PIPELINE_METHODS)
    expect(registry.size).toBe(10)
    expect(registry.has('pipelines.templateList')).toBe(true)
    expect(registry.has('pipelines.run')).toBe(true)
    expect(registry.has('pipelines.list')).toBe(true)
    expect(registry.has('pipelines.show')).toBe(true)
    expect(registry.has('pipelines.cancel')).toBe(true)
    expect(registry.has('pipelines.logs')).toBe(true)
    expect(registry.has('pipelines.releaseStaleReservation')).toBe(true)
    expect(registry.has('pipelines.prdCandidates')).toBe(true)
    expect(registry.has('pipelines.recoveryReportList')).toBe(true)
    expect(registry.has('pipelines.recoveryReportAcknowledge')).toBe(true)
    expect(registry.has('pipelines.retryStage')).toBe(false)
  })

  it('lists built-in templates', async () => {
    setup()
    const result = (await call('pipelines.templateList')) as { templates: { id: string }[] }
    expect(result.templates).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'parallel-planner-with-review' })])
    )
  })

  it('creates, lists, shows, logs, and cancels a run', async () => {
    const service = setup()
    const created = (await call(
      'pipelines.run',
      runInput() as unknown as Record<string, unknown>
    )) as {
      run: { id: string; status: string }
    }
    service.db.appendLog({
      runId: created.run.id,
      level: 'info',
      message: 'created from test'
    })

    const list = (await call('pipelines.list', { repoId: 'repo_orca' })) as {
      runs: { id: string }[]
    }
    const shown = (await call('pipelines.show', { runId: created.run.id })) as {
      run: { id: string }
      logs: { message: string }[]
    }
    const logs = (await call('pipelines.logs', { runId: created.run.id })) as {
      logs: { message: string }[]
    }
    const cancelled = (await call('pipelines.cancel', { runId: created.run.id })) as {
      run: { status: string }
    }

    expect(list.runs).toEqual([expect.objectContaining({ id: created.run.id })])
    expect(shown.run.id).toBe(created.run.id)
    expect(shown.logs).toEqual([expect.objectContaining({ message: 'created from test' })])
    expect(logs.logs).toEqual([expect.objectContaining({ message: 'created from test' })])
    expect(cancelled.run.status).toBe('cancelled')
  })

  it('validates required run fields', () => {
    const method = findMethod('pipelines.run')
    expect(() => method.params!.parse({ repoId: 'repo_orca' })).toThrow()
    expect(() =>
      method.params!.parse({
        ...runInput(),
        taskSource: { type: 'manual', tasks: [] }
      })
    ).toThrow()
  })

  it('lists and acknowledges recovery reports through RPC', async () => {
    const service = setup()
    const created = (await call(
      'pipelines.run',
      runInput() as unknown as Record<string, unknown>
    )) as {
      run: { id: string }
    }
    const report = service.db.createRecoveryReport({
      interruptedRunId: created.run.id,
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

    const list = (await call('pipelines.recoveryReportList', {
      repoId: 'repo_orca',
      prdIssueNumber: 13,
      status: 'pending_ack'
    })) as { reports: { id: string; status: string }[] }
    const acknowledged = (await call('pipelines.recoveryReportAcknowledge', {
      reportId: report.id
    })) as { report: { id: string; status: string } }

    expect(list.reports).toEqual([expect.objectContaining({ id: report.id })])
    expect(acknowledged.report).toMatchObject({ id: report.id, status: 'acknowledged' })
  })

  it('returns PRD candidates through RPC', async () => {
    setup({
      githubCommandRunner: async ({ args }) => {
        if (args.includes('prd')) {
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

    const result = (await call('pipelines.prdCandidates', {
      repoId: 'repo_orca',
      owner: 'Nikolatesla-lj',
      repo: 'orca',
      limit: 5
    })) as { candidates: { prdIssueNumber: number; readyTaskCount: number }[] }

    expect(result.candidates).toEqual([
      expect.objectContaining({ prdIssueNumber: 13, readyTaskCount: 1 })
    ])
  })
})
