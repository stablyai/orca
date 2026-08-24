import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import {
  formatCrashReportText,
  sanitizeCrashReportDetails,
  type CrashReportRecord
} from '../../shared/crash-reporting'
import {
  recentRendererErrorReportKeys,
  recordRendererErrorReport
} from './crash-reporting-renderer-error-report'

vi.mock('electron', () => ({ app: { getVersion: () => '1.4.188' } }))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  getCrashBreadcrumbSnapshot: () => []
}))

const REACT_185_DIGEST =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message.'

function makeStore(): { store: CrashReportStore; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn(async (input: { details: Record<string, unknown> }) => ({
    id: 'crash-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    status: 'pending',
    source: 'renderer',
    processType: 'react-render',
    reason: 'react-error-boundary',
    exitCode: null,
    appVersion: '1.4.188',
    platform: 'darwin',
    osRelease: '25.0.0',
    arch: 'arm64',
    electronVersion: '41.0.0',
    chromeVersion: '141.0.0',
    details: sanitizeCrashReportDetails(input.details)
  }))
  return { store: { record } as unknown as CrashReportStore, record }
}

function baseArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boundaryId: 'page.automations',
    surface: 'page',
    errorName: 'Error',
    errorMessage: REACT_185_DIGEST,
    componentStack: 'at AutomationsPage\nat App',
    ...overrides
  }
}

describe('renderer error report attribution', () => {
  beforeEach(() => {
    recentRendererErrorReportKeys.clear()
  })

  it('stamps unreliable attribution plus a human-readable note on the stored report', async () => {
    const { store, record } = makeStore()

    const result = await recordRendererErrorReport(store, baseArgs({ attribution: 'unreliable' }))

    expect(result).toMatchObject({ ok: true, deduped: false })
    const details = record.mock.calls[0]?.[0]?.details as Record<string, unknown>
    expect(details.attribution).toBe('unreliable')
    expect(String(details.attribution_note)).toContain('boundary_id')
    // Boundary id stays intact for continuity with existing triage.
    expect(details.boundary_id).toBe('page.automations')
  })

  it('omits attribution when the renderer does not send one', async () => {
    const { store, record } = makeStore()

    await recordRendererErrorReport(store, baseArgs())

    const details = record.mock.calls[0]?.[0]?.details as Record<string, unknown>
    expect(details).not.toHaveProperty('attribution')
    expect(details).not.toHaveProperty('attribution_note')
  })

  it('ignores unknown attribution values from a newer or hostile renderer', async () => {
    const { store, record } = makeStore()

    await recordRendererErrorReport(store, baseArgs({ attribution: 'definitely-this-component' }))

    const details = record.mock.calls[0]?.[0]?.details as Record<string, unknown>
    expect(details).not.toHaveProperty('attribution')
  })

  it('surfaces the caveat in the formatted report text a human reads', async () => {
    const { store } = makeStore()

    const result = await recordRendererErrorReport(store, baseArgs({ attribution: 'unreliable' }))
    const report = (result as { report: CrashReportRecord }).report
    const text = formatCrashReportText(report)

    expect(text).toContain('Attribution: unreliable')
    expect(text).toContain('boundary_id')
    expect(text.indexOf('Attribution: unreliable')).toBeLessThan(text.indexOf('Details:'))
  })
})
