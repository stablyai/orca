import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrashReportStore } from '../../crash-reporting/reports/crash-report-store'
import { recordRendererErrorReport } from './crash-reporting-renderer-error-report'

const { recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordDurableCrashBreadcrumbMock: vi.fn()
}))
vi.mock('../../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0', getPath: () => '' } }))

describe('recordRendererErrorReport', () => {
  const dir = mkdtempSync(join(tmpdir(), 'renderer-error-report-'))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes a contained render crash to the trace', async () => {
    const store = new CrashReportStore(join(dir, 'crash-reports.json'))
    await recordRendererErrorReport(
      store,
      {
        boundaryId: 'sidebar.worktrees',
        surface: 'sidebar',
        errorName: 'Error',
        errorMessage: 'Too many re-renders.',
        componentStack: 'at SidebarBotsSection'
      },
      7
    )
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith(
      'react_error_boundary_crash',
      {
        boundary_id: 'sidebar.worktrees',
        surface: 'sidebar',
        error_name: 'Error',
        error_message: 'Too many re-renders.',
        component_stack: 'at SidebarBotsSection'
      },
      undefined,
      'renderer:7'
    )
  })
})
