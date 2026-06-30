import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { PIPELINE_HANDLERS } from './pipelines'

describe('pipeline CLI handlers', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: {} })
  })

  const invoke = (command: string, flags: Map<string, string | boolean>) =>
    PIPELINE_HANDLERS[command]({
      flags,
      client: { call: callMock },
      cwd: '/repo',
      json: true
    } as never)

  it('maps template-list to pipelines.templateList', async () => {
    await invoke('pipelines template-list', new Map())
    expect(callMock).toHaveBeenCalledWith('pipelines.templateList', {})
  })

  it('maps run flags to pipelines.run', async () => {
    await invoke(
      'pipelines run',
      new Map<string, string | boolean>([
        ['template', 'parallel-planner-with-review'],
        ['repo', 'repo_orca'],
        ['source-branch', 'main'],
        ['target-branch', 'pipeline-output'],
        ['task-source', 'github'],
        ['task-owner', 'Nikolatesla-lj'],
        ['task-repo', 'orca'],
        ['prd-issue', '13'],
        ['max-concurrent', '2'],
        ['max-iterations', '3'],
        ['planner-agent', 'codex'],
        ['implementer-agent', 'codex'],
        ['merger-agent', 'codex'],
        ['execution-target-type', 'local']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'pipelines.run',
      expect.objectContaining({
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
      })
    )
  })

  it('forces sequential reviewer concurrency to one', async () => {
    await invoke(
      'pipelines run',
      new Map<string, string | boolean>([
        ['template', 'sequential-reviewer'],
        ['repo', 'repo_orca'],
        ['source-branch', 'main'],
        ['target-branch', 'pipeline-output'],
        ['task-source', 'github'],
        ['task-owner', 'Nikolatesla-lj'],
        ['task-repo', 'orca'],
        ['prd-issue', '13'],
        ['max-concurrent', '4'],
        ['planner-agent', 'codex'],
        ['implementer-agent', 'codex'],
        ['merger-agent', 'codex']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'pipelines.run',
      expect.objectContaining({ templateId: 'sequential-reviewer', maxConcurrent: 1 })
    )
  })

  it('rejects public manual task sources', async () => {
    await expect(
      invoke(
        'pipelines run',
        new Map<string, string | boolean>([
          ['template', 'parallel-planner-with-review'],
          ['repo', 'repo_orca'],
          ['source-branch', 'main'],
          ['target-branch', 'pipeline-output'],
          ['task-source', 'manual'],
          ['planner-agent', 'codex'],
          ['implementer-agent', 'codex'],
          ['merger-agent', 'codex']
        ])
      )
    ).rejects.toThrow('--task-source must be github')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('maps list/show/logs/cancel and recovery commands', async () => {
    await invoke('pipelines list', new Map([['repo', 'repo_orca']]))
    await invoke('pipelines show', new Map([['run', 'pipe_run_1']]))
    await invoke('pipelines logs', new Map([['run', 'pipe_run_1']]))
    await invoke('pipelines cancel', new Map([['run', 'pipe_run_1']]))
    await invoke(
      'pipelines release-stale-reservation',
      new Map<string, string | boolean>([
        ['reservation', 'pipe_res_1'],
        ['confirm', true]
      ])
    )
    await invoke(
      'pipelines recovery-reports',
      new Map<string, string | boolean>([
        ['repo', 'repo_orca'],
        ['prd-issue', '13'],
        ['status', 'pending_ack']
      ])
    )
    await invoke('pipelines recovery-report-acknowledge', new Map([['report', 'pipe_recovery_1']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'pipelines.list', {
      repoId: 'repo_orca',
      status: undefined,
      limit: undefined
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'pipelines.show', { runId: 'pipe_run_1' })
    expect(callMock).toHaveBeenNthCalledWith(3, 'pipelines.logs', {
      runId: 'pipe_run_1',
      stageId: undefined,
      taskId: undefined,
      limit: undefined
    })
    expect(callMock).toHaveBeenNthCalledWith(4, 'pipelines.cancel', {
      runId: 'pipe_run_1',
      preserveWorktrees: undefined
    })
    expect(callMock).toHaveBeenNthCalledWith(5, 'pipelines.releaseStaleReservation', {
      reservationId: 'pipe_res_1',
      confirm: true
    })
    expect(callMock).toHaveBeenNthCalledWith(6, 'pipelines.recoveryReportList', {
      repoId: 'repo_orca',
      prdIssueNumber: 13,
      status: 'pending_ack'
    })
    expect(callMock).toHaveBeenNthCalledWith(7, 'pipelines.recoveryReportAcknowledge', {
      reportId: 'pipe_recovery_1'
    })
  })
})
