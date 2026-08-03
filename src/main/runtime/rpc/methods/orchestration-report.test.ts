import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_REPORT_METHODS } from './orchestration-report'

describe('orchestration.report RPC', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    db?.close()
  })

  it('reads the selected Run through the existing runtime database', async () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'redacted',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    db.createTask({ runId: run.id, spec: 'redacted task' })
    const method = ORCHESTRATION_REPORT_METHODS[0]

    const result = await method.handler({ id: run.id }, {
      runtime: {
        getOrchestrationDb: () => db,
        getOrchestrationUsageSnapshots: async () => [],
        resolveOrchestrationReportWorktreeHostScope: () => 'local'
      }
    } as never)

    expect(result).toMatchObject({
      schemaVersion: 1,
      run: { id: run.id },
      graph: { rootTaskIds: [expect.stringMatching(/^task_/)] }
    })
  })

  it('awaits refreshed provider snapshots and preserves a partial report on provider failure', async () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'redacted',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const method = ORCHESTRATION_REPORT_METHODS[0]
    const refresh = vi.fn(async () => [
      {
        provider: 'codex' as const,
        status: 'available' as const,
        lastScanCompletedAt: Date.now(),
        message: null,
        limitations: [],
        sessions: [],
        truncated: false
      },
      {
        provider: 'claude' as const,
        status: 'error' as const,
        lastScanCompletedAt: null,
        message: 'claude usage refresh failed.',
        limitations: [],
        sessions: [],
        truncated: false
      },
      {
        provider: 'opencode' as const,
        status: 'disabled' as const,
        lastScanCompletedAt: null,
        message: 'OpenCode usage tracking is disabled.',
        limitations: [],
        sessions: [],
        truncated: false
      }
    ])

    const result = await method.handler({ id: run.id }, {
      runtime: {
        getOrchestrationDb: () => db,
        getOrchestrationUsageSnapshots: refresh,
        resolveOrchestrationReportWorktreeHostScope: () => 'local'
      }
    } as never)

    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(null)
    expect(result).toMatchObject({
      completeness: {
        status: 'partial',
        providerSessions: [
          { provider: 'codex', status: 'available' },
          { provider: 'claude', status: 'error' },
          { provider: 'opencode', status: 'disabled' }
        ]
      }
    })
  })

  it('derives the refresh boundary before reading final report rows', async () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'redacted',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const firstTask = db.createTask({ runId: run.id, spec: 'first task' })
    const completedTask = db.updateTaskStatus(firstTask.id, 'completed')
    const completedAt = Date.parse(completedTask?.completed_at ?? '')
    const getRunReportCompletionAt = vi.spyOn(db, 'getRunReportCompletionAt')
    const getRunReportRecords = vi.spyOn(db, 'getRunReportRecords')
    const refresh = vi.fn(async (boundary: number | null) => {
      expect(boundary).toBe(completedAt)
      expect(getRunReportCompletionAt).toHaveBeenCalledTimes(1)
      expect(getRunReportRecords).not.toHaveBeenCalled()
      db?.createTask({ runId: run.id, spec: 'task created during refresh' })
      return []
    })
    const method = ORCHESTRATION_REPORT_METHODS[0]

    const result = await method.handler({ id: run.id }, {
      runtime: {
        getOrchestrationDb: () => db,
        getOrchestrationUsageSnapshots: refresh,
        resolveOrchestrationReportWorktreeHostScope: () => 'local'
      }
    } as never)

    expect(getRunReportRecords).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      graph: { rootTaskIds: [expect.any(String), expect.any(String)] }
    })
  })

  it('returns run_not_found without creating records', async () => {
    db = new OrchestrationDb(':memory:')
    const method = ORCHESTRATION_REPORT_METHODS[0]

    await expect(
      method.handler({ id: 'run_missing' }, {
        runtime: {
          getOrchestrationDb: () => db,
          getOrchestrationUsageSnapshots: async () => [],
          resolveOrchestrationReportWorktreeHostScope: () => 'local'
        }
      } as never)
    ).rejects.toMatchObject({ code: 'run_not_found' })
    expect(db.listRuns().runs).toHaveLength(1)
  })
})
