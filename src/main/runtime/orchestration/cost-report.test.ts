import { describe, expect, it } from 'vitest'
import type { OrchestrationReportRecords } from './db'
import type { OrchestrationReportUsageSnapshot } from '../../../shared/orchestration-cost-report'
import { buildOrchestrationCostReport } from './cost-report'

const LOCAL_WORKTREE_HOSTS = [
  { worktreeId: 'repo::/redacted/root', scope: 'local' as const },
  { worktreeId: 'repo::/redacted/child', scope: 'local' as const }
]

function records(): OrchestrationReportRecords {
  return {
    run: {
      id: 'run_redacted',
      objective: 'must not appear',
      home_database: 'this_database',
      coordinator_handle: null,
      coordinator_pane_key: null,
      consumer_generation: 0,
      legacy: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:30.000Z'
    },
    tasks: [
      {
        id: 'task_root',
        run_id: 'run_redacted',
        parent_id: null,
        status: 'completed',
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:30.000Z'
      },
      {
        id: 'task_child',
        run_id: 'run_redacted',
        parent_id: 'task_root',
        status: 'completed',
        created_at: '2026-01-01T00:00:05.000Z',
        completed_at: '2026-01-01T00:00:25.000Z'
      }
    ],
    dispatches: [
      {
        id: 'ctx_root',
        run_id: 'run_redacted',
        task_id: 'task_root',
        status: 'completed',
        assignee_handle: 'term_root',
        created_at: '2026-01-01T00:00:00.000Z',
        dispatched_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:20.000Z',
        worker_state: 'succeeded',
        worktree_id: 'repo::/redacted/root',
        agent_terminal_handle: 'term_root',
        environment_id: null,
        environment_name: null,
        remote_worktree_id: null,
        remote_terminal_handle: null
      },
      {
        id: 'ctx_child',
        run_id: 'run_redacted',
        task_id: 'task_child',
        status: 'completed',
        assignee_handle: 'term_child',
        created_at: '2026-01-01T00:00:10.000Z',
        dispatched_at: '2026-01-01T00:00:10.000Z',
        completed_at: '2026-01-01T00:00:30.000Z',
        worker_state: 'succeeded',
        worktree_id: 'repo::/redacted/child',
        agent_terminal_handle: 'term_child',
        environment_id: null,
        environment_name: null,
        remote_worktree_id: null,
        remote_terminal_handle: null
      }
    ],
    taskCount: 2,
    dispatchCount: 2
  }
}

function usage(): OrchestrationReportUsageSnapshot[] {
  return [
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
          sessionId: 'session_root',
          firstTimestamp: '2026-01-01T00:00:01.000Z',
          lastTimestamp: '2026-01-01T00:00:09.000Z',
          worktreeId: 'repo::/redacted/root',
          locationStatus: 'exact',
          model: 'gpt-redacted',
          metrics: {
            inputTokens: 10,
            cachedInputTokens: 4,
            outputTokens: 5,
            reasoningOutputTokens: 2,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            totalTokens: 17,
            estimatedCostUsd: 0.01,
            costStatus: 'known'
          }
        }
      ]
    },
    {
      provider: 'claude',
      status: 'available',
      lastScanCompletedAt: 1,
      message: null,
      limitations: [],
      truncated: false,
      sessions: [
        {
          provider: 'claude',
          sessionId: 'session_ambiguous',
          firstTimestamp: '2026-01-01T00:00:12.000Z',
          lastTimestamp: '2026-01-01T00:00:15.000Z',
          worktreeId: 'repo::/redacted/root',
          locationStatus: 'exact',
          model: 'claude-redacted',
          metrics: {
            inputTokens: 20,
            cachedInputTokens: null,
            outputTokens: 3,
            reasoningOutputTokens: null,
            cacheReadTokens: 8,
            cacheWriteTokens: 1,
            totalTokens: 32,
            estimatedCostUsd: null,
            costStatus: 'unavailable'
          }
        }
      ]
    }
  ]
}

describe('buildOrchestrationCostReport', () => {
  it('unions elapsed intervals and attributes each session at most once', () => {
    const report = buildOrchestrationCostReport({
      records: records(),
      usageSnapshots: usage(),
      worktreeHosts: LOCAL_WORKTREE_HOSTS,
      generatedAt: '2026-01-01T00:01:00.000Z'
    })

    expect(report.totals.elapsed).toEqual({ milliseconds: 30_000, status: 'available' })
    expect(report.graph.tasks[0].elapsed.rolledUp.milliseconds).toBe(30_000)
    expect(report.attribution.attributed).toEqual([
      {
        provider: 'claude',
        sessionId: 'session_ambiguous',
        dispatchId: 'ctx_root',
        certainty: 'inferred'
      },
      {
        provider: 'codex',
        sessionId: 'session_root',
        dispatchId: 'ctx_root',
        certainty: 'inferred'
      }
    ])
    expect(report.totals.usage.attributionCertainty).toBe('inferred')
    expect(report.totals.usage.providers[0]).toMatchObject({
      provider: 'codex',
      sessionCount: 1,
      metrics: { totalTokens: 17, estimatedCostUsd: 0.01 }
    })
    expect(JSON.stringify(report)).not.toContain('must not appear')
  })

  it('marks multiple same-worktree overlapping attempts ambiguous', () => {
    const inputRecords = records()
    inputRecords.dispatches[1].worktree_id = 'repo::/redacted/root'
    const report = buildOrchestrationCostReport({
      records: inputRecords,
      usageSnapshots: usage(),
      worktreeHosts: LOCAL_WORKTREE_HOSTS,
      generatedAt: '2026-01-01T00:01:00.000Z'
    })

    expect(report.attribution.ambiguous).toEqual([
      {
        provider: 'claude',
        sessionId: 'session_ambiguous',
        eligibleDispatchIds: ['ctx_child', 'ctx_root']
      }
    ])
    expect(report.totals.usage.providers).toEqual([
      expect.objectContaining({ provider: 'codex', sessionCount: 1 })
    ])
  })

  it('reports malformed intervals and unavailable providers as partial', () => {
    const inputRecords = records()
    inputRecords.dispatches[0].completed_at = 'malformed'
    const report = buildOrchestrationCostReport({
      records: inputRecords,
      usageSnapshots: [],
      worktreeHosts: LOCAL_WORKTREE_HOSTS,
      generatedAt: '2026-01-01T00:01:00.000Z'
    })

    expect(report.completeness.status).toBe('partial')
    expect(
      report.completeness.providerSessions.every((row) => row.completeness === 'unavailable')
    ).toBe(true)
    expect(report.graph.tasks[0].elapsed.direct.status).toBe('unavailable')
    expect(report.completeness.warnings[0]).toContain('malformed')
    expect(report.completeness.providerSessions.every((row) => row.status === 'error')).toBe(true)
  })

  it('surfaces stale provider snapshots as incomplete provenance', () => {
    const snapshots = usage()
    snapshots[0] = {
      ...snapshots[0],
      status: 'stale',
      message: 'Codex usage snapshot is stale.',
      sessions: []
    }
    const report = buildOrchestrationCostReport({
      records: records(),
      usageSnapshots: snapshots,
      worktreeHosts: LOCAL_WORKTREE_HOSTS,
      generatedAt: '2026-01-01T00:01:00.000Z'
    })

    expect(report.completeness.status).toBe('partial')
    expect(report.completeness.providerSessions[0].status).toBe('stale')
    expect(report.completeness.warnings).toContain(
      'codex usage unavailable: Codex usage snapshot is stale.'
    )
  })

  it('does not attribute sessions that only overlap or belong to a remote Dispatch', () => {
    const inputRecords = records()
    inputRecords.dispatches[0].environment_id = 'env_remote'
    inputRecords.dispatches[0].remote_worktree_id = 'repo::/redacted/root'
    const snapshots = usage()
    snapshots[1].sessions[0].firstTimestamp = '2025-12-31T23:59:59.000Z'

    const report = buildOrchestrationCostReport({
      records: inputRecords,
      usageSnapshots: snapshots,
      worktreeHosts: LOCAL_WORKTREE_HOSTS,
      generatedAt: '2026-01-01T00:01:00.000Z'
    })

    expect(report.attribution.attributed).toEqual([])
    expect(report.attribution.unlinked).toEqual([
      {
        provider: 'claude',
        sessionId: 'session_ambiguous',
        reason: 'session_not_contained_in_dispatch_interval'
      },
      {
        provider: 'codex',
        sessionId: 'session_root',
        reason: 'remote_dispatch_usage_unavailable'
      }
    ])
    expect(report.completeness.status).toBe('partial')
    expect(report.completeness.providerSessions).toEqual([
      expect.objectContaining({ provider: 'codex', completeness: 'partial' }),
      expect.objectContaining({ provider: 'claude', completeness: 'partial' }),
      expect.objectContaining({ provider: 'opencode', completeness: 'unavailable' })
    ])
    expect(report.provenance.usageHostScope).toBe('runtime_host_local_only')
    expect(report.completeness.warnings).toContain(
      '1 remote Dispatch(es) were excluded from host-local usage attribution.'
    )
  })
})
