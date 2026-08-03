import { describe, expect, it } from 'vitest'
import type { OrchestrationReportRecords } from './db'
import type { OrchestrationReportUsageSnapshot } from '../../../shared/orchestration-cost-report'
import { buildOrchestrationCostReport } from './cost-report'

const records: OrchestrationReportRecords = {
  run: {
    id: 'run_ssh',
    objective: 'redacted',
    home_database: 'this_database',
    coordinator_handle: null,
    coordinator_pane_key: null,
    consumer_generation: 0,
    legacy: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:10.000Z'
  },
  tasks: [
    {
      id: 'task_ssh',
      run_id: 'run_ssh',
      parent_id: null,
      status: 'completed',
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:10.000Z'
    }
  ],
  dispatches: [
    {
      id: 'ctx_ssh',
      run_id: 'run_ssh',
      task_id: 'task_ssh',
      status: 'completed',
      assignee_handle: 'term_ssh',
      created_at: '2026-01-01T00:00:00.000Z',
      dispatched_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:10.000Z',
      worker_state: 'succeeded',
      worktree_id: 'repo_ssh::/remote/worktree',
      agent_terminal_handle: 'term_ssh',
      environment_id: null,
      environment_name: null,
      remote_worktree_id: null,
      remote_terminal_handle: null
    }
  ],
  taskCount: 1,
  dispatchCount: 1
}

const usage: OrchestrationReportUsageSnapshot[] = [
  {
    provider: 'codex',
    status: 'available',
    lastScanCompletedAt: 1,
    message: null,
    limitations: [],
    truncated: false,
    sessions: [
      {
        provider: 'codex',
        sessionId: 'session_ssh',
        firstTimestamp: '2026-01-01T00:00:01.000Z',
        lastTimestamp: '2026-01-01T00:00:09.000Z',
        worktreeId: 'repo_ssh::/remote/worktree',
        locationStatus: 'exact',
        model: 'gpt-redacted',
        metrics: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: 15,
          estimatedCostUsd: 0.01,
          costStatus: 'known'
        }
      }
    ]
  }
]

describe('orchestration report Dispatch host scope', () => {
  it('excludes ordinary SSH-backed Dispatches from host-local usage', () => {
    const report = buildOrchestrationCostReport({
      records,
      usageSnapshots: usage,
      worktreeHosts: [{ worktreeId: 'repo_ssh::/remote/worktree', scope: 'remote' }],
      generatedAt: '2026-01-01T00:00:11.000Z'
    })

    expect(report.graph.tasks[0].dispatches[0].identities.hostScope).toBe('remote')
    expect(report.attribution.attributed).toEqual([])
    expect(report.attribution.unlinked[0]?.reason).toBe('remote_dispatch_usage_unavailable')
    expect(report.completeness.status).toBe('partial')
    expect(report.completeness.warnings).toContain(
      '1 remote Dispatch(es) were excluded from host-local usage attribution.'
    )
  })

  it('fails closed when the Dispatch host cannot be resolved', () => {
    const report = buildOrchestrationCostReport({
      records,
      usageSnapshots: usage,
      worktreeHosts: [],
      generatedAt: '2026-01-01T00:00:11.000Z'
    })

    expect(report.graph.tasks[0].dispatches[0].identities.hostScope).toBe('unknown')
    expect(report.attribution.unlinked[0]?.reason).toBe('dispatch_host_scope_unknown')
    expect(report.completeness.status).toBe('partial')
    expect(report.completeness.warnings).toContain(
      '1 Dispatch host scope(s) could not be resolved; usage attribution was excluded.'
    )
  })
})
