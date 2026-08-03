import { describe, expect, it, vi } from 'vitest'
import type {
  OrchestrationReportProvider,
  OrchestrationReportUsageSnapshot
} from '../../../shared/orchestration-cost-report'
import {
  ORCHESTRATION_REPORT_USAGE_REFRESH_TIMEOUT_MS,
  refreshOrchestrationReportUsageSnapshots,
  type OrchestrationReportUsageStore
} from './cost-report-usage-refresh'

function snapshot(
  provider: OrchestrationReportProvider,
  status: OrchestrationReportUsageSnapshot['status']
): OrchestrationReportUsageSnapshot {
  return {
    provider,
    status,
    lastScanCompletedAt: status === 'available' ? Date.now() : null,
    message: status === 'available' ? null : `${provider} usage is ${status}.`,
    limitations: [],
    sessions: [],
    truncated: false
  }
}

function refreshingStore(
  provider: OrchestrationReportProvider,
  initialStatus: 'uninitialized' | 'stale'
): OrchestrationReportUsageStore & { refresh: ReturnType<typeof vi.fn> } {
  let status: OrchestrationReportUsageSnapshot['status'] = initialStatus
  let lastScanCompletedAt = initialStatus === 'stale' ? Date.now() - 10 * 60_000 : null
  return {
    refresh: vi.fn(async () => {
      status = 'available'
      lastScanCompletedAt = Date.now()
    }),
    getScanState: () => ({ enabled: true, lastScanCompletedAt, lastScanError: null }),
    getOrchestrationReportUsage: () => snapshot(provider, status)
  }
}

describe('refreshOrchestrationReportUsageSnapshots', () => {
  it('refreshes uninitialized and stale stores before reading report snapshots', async () => {
    const codex = refreshingStore('codex', 'uninitialized')
    const claude = refreshingStore('claude', 'stale')
    let disabledScanStarted = false
    const openCode: OrchestrationReportUsageStore = {
      refresh: vi.fn(async (force = false) => {
        disabledScanStarted = force
      }),
      getScanState: () => ({ enabled: false, lastScanCompletedAt: null, lastScanError: null }),
      getOrchestrationReportUsage: () => snapshot('opencode', 'disabled')
    }

    const result = await refreshOrchestrationReportUsageSnapshots(
      [
        { provider: 'codex', store: codex },
        { provider: 'claude', store: claude },
        { provider: 'opencode', store: openCode }
      ],
      { completedAt: null, limit: 20 }
    )

    expect(codex.refresh).toHaveBeenCalledWith(false)
    expect(claude.refresh).toHaveBeenCalledWith(false)
    expect(openCode.refresh).toHaveBeenCalledWith(false)
    expect(disabledScanStarted).toBe(false)
    expect(result.map(({ status }) => status)).toEqual(['available', 'available', 'disabled'])
  })

  it('returns partial provider snapshots when one refresh or snapshot read fails', async () => {
    const codex = refreshingStore('codex', 'stale')
    const claude: OrchestrationReportUsageStore = {
      getScanState: () => ({ enabled: true, lastScanCompletedAt: null, lastScanError: null }),
      refresh: async () => {
        throw new Error('scan failed')
      },
      getOrchestrationReportUsage: () => snapshot('claude', 'available')
    }
    const openCode: OrchestrationReportUsageStore = {
      getScanState: () => ({ enabled: true, lastScanCompletedAt: null, lastScanError: null }),
      refresh: async () => {},
      getOrchestrationReportUsage: () => {
        throw new Error('snapshot failed')
      }
    }

    await expect(
      refreshOrchestrationReportUsageSnapshots(
        [
          { provider: 'codex', store: codex },
          { provider: 'claude', store: claude },
          { provider: 'opencode', store: openCode }
        ],
        { completedAt: null, limit: 20 }
      )
    ).resolves.toMatchObject([
      { provider: 'codex', status: 'available' },
      { provider: 'claude', status: 'error', sessions: [] },
      { provider: 'opencode', status: 'error', sessions: [] }
    ])
  })

  it('forces a fresh snapshot captured before completion exactly once', async () => {
    let lastScanCompletedAt = 1_000
    const refresh = vi.fn(async () => {
      lastScanCompletedAt = 3_000
    })
    const store: OrchestrationReportUsageStore = {
      getScanState: () => ({ enabled: true, lastScanCompletedAt, lastScanError: null }),
      refresh,
      getOrchestrationReportUsage: () => snapshot('codex', 'available')
    }

    await refreshOrchestrationReportUsageSnapshots([{ provider: 'codex', store }], {
      completedAt: 2_000,
      limit: 20
    })
    await refreshOrchestrationReportUsageSnapshots([{ provider: 'codex', store }], {
      completedAt: 2_000,
      limit: 20
    })

    expect(refresh).toHaveBeenNthCalledWith(1, true)
    expect(refresh).toHaveBeenNthCalledWith(2, false)
  })

  it('times out one provider independently while preserving completed providers', async () => {
    expect(ORCHESTRATION_REPORT_USAGE_REFRESH_TIMEOUT_MS).toBeLessThan(10_000)
    vi.useFakeTimers()
    try {
      const neverSettles: OrchestrationReportUsageStore = {
        getScanState: () => ({ enabled: true, lastScanCompletedAt: null, lastScanError: null }),
        refresh: () => new Promise(() => {}),
        getOrchestrationReportUsage: () => snapshot('claude', 'available')
      }
      const codex = refreshingStore('codex', 'uninitialized')

      const resultPromise = refreshOrchestrationReportUsageSnapshots(
        [
          { provider: 'codex', store: codex },
          { provider: 'claude', store: neverSettles }
        ],
        { completedAt: null, limit: 20, timeoutMs: 100 }
      )
      await vi.advanceTimersByTimeAsync(100)

      await expect(resultPromise).resolves.toMatchObject([
        { provider: 'codex', status: 'available' },
        { provider: 'claude', status: 'error', sessions: [] }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
