import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportCreateInput } from '../../shared/crash-reporting'
import type { ActiveSpan } from '../observability/tracer'
import { recordProcessGoneCrash, type RecordProcessGoneCrashRuntime } from './process-gone-crash'

type MockFn = ReturnType<typeof vi.fn>
type TestRuntime = RecordProcessGoneCrashRuntime & {
  crashReports: { record: MockFn } | null
  dedupe: { shouldRecord: MockFn }
  getCrashBreadcrumbSnapshot: MockFn
  recordCrashBreadcrumb: MockFn
  startSpan: MockFn
  recordNoCaptureDiagnostic: MockFn
}

function runtime(overrides: Partial<RecordProcessGoneCrashRuntime> = {}): TestRuntime {
  const span: ActiveSpan = {
    traceId: 'trace',
    spanId: 'span',
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
    fail: vi.fn(),
    interrupt: vi.fn(),
    end: vi.fn()
  }
  const testRuntime: RecordProcessGoneCrashRuntime = {
    crashReports: { record: vi.fn(() => Promise.resolve({ id: 'report' } as never)) },
    expectedTeardown: 'none',
    getCrashBreadcrumbSnapshot: vi.fn(() => [
      { createdAt: '2026-05-16T01:00:00.000Z', name: 'before_crash' }
    ]),
    recordCrashBreadcrumb: vi.fn(),
    dedupe: { shouldRecord: vi.fn(() => true) },
    getAppVersion: () => '1.0.0',
    osRelease: 'test-os',
    platform: 'win32',
    arch: 'x64',
    electronVersion: '42',
    chromeVersion: '141',
    startSpan: vi.fn(() => span),
    recordNoCaptureDiagnostic: vi.fn(),
    ...overrides
  }
  return testRuntime as TestRuntime
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('recordProcessGoneCrash', () => {
  it('does not emit a no-capture span for non-report reasons', () => {
    const testRuntime = runtime({ crashReports: null })

    recordProcessGoneCrash('renderer', 'renderer', 'clean-exit', 0, {}, testRuntime)

    expect(testRuntime.recordNoCaptureDiagnostic).not.toHaveBeenCalled()
    expect(testRuntime.recordCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('records a store-unavailable no-capture span for reportable events without a store', () => {
    const testRuntime = runtime({ crashReports: null })

    recordProcessGoneCrash('child', 'renderer', 'crashed', null, { name: 'Renderer' }, testRuntime)

    expect(testRuntime.recordNoCaptureDiagnostic).toHaveBeenCalledWith(
      'process_gone_store_unavailable',
      {
        source: 'child',
        processType: 'renderer',
        reason: 'crashed',
        exitCode: null,
        details: { name: 'Renderer' }
      }
    )
    expect(testRuntime.recordCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('records suppressed breadcrumb and durable no-capture span for expected teardown', () => {
    const testRuntime = runtime({ expectedTeardown: 'renderer-reload' })

    recordProcessGoneCrash('renderer', 'renderer', 'killed', 15, { name: 'Renderer' }, testRuntime)

    expect(testRuntime.recordCrashBreadcrumb).toHaveBeenCalledWith('process_gone_suppressed', {
      source: 'renderer',
      processType: 'renderer',
      reason: 'killed',
      exitCode: 15,
      name: 'Renderer'
    })
    expect(testRuntime.recordNoCaptureDiagnostic).toHaveBeenCalledWith('process_gone_suppressed', {
      source: 'renderer',
      processType: 'renderer',
      reason: 'killed',
      exitCode: 15,
      details: { name: 'Renderer' }
    })
    expect(testRuntime.crashReports?.record).not.toHaveBeenCalled()
  })

  it('keeps deduped reportable events silent', () => {
    const testRuntime = runtime({ dedupe: { shouldRecord: vi.fn(() => false) } })

    recordProcessGoneCrash('renderer', 'renderer', 'crashed', 5, {}, testRuntime)

    expect(testRuntime.dedupe.shouldRecord).toHaveBeenCalledWith('renderer:renderer')
    expect(testRuntime.startSpan).not.toHaveBeenCalled()
    expect(testRuntime.crashReports?.record).not.toHaveBeenCalled()
    expect(testRuntime.recordNoCaptureDiagnostic).not.toHaveBeenCalled()
  })

  it('persists accepted reportable events with crash context and breadcrumbs', () => {
    const testRuntime = runtime()

    recordProcessGoneCrash(
      'renderer',
      'renderer',
      'crashed',
      5,
      { serviceName: 'renderer' },
      testRuntime
    )

    expect(testRuntime.startSpan).toHaveBeenCalledWith('electron.process_gone', {
      attributes: expect.objectContaining({
        'crash.source': 'renderer',
        'crash.process_type': 'renderer',
        'crash.reason': 'crashed',
        'crash.exit_code': 5,
        'app.version': '1.0.0',
        details: expect.objectContaining({ serviceName: 'renderer' }),
        breadcrumbs: [{ createdAt: '2026-05-16T01:00:00.000Z', name: 'before_crash' }]
      })
    })
    expect(testRuntime.crashReports?.record).toHaveBeenCalledWith({
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: 5,
      appVersion: '1.0.0',
      platform: 'win32',
      osRelease: 'test-os',
      arch: 'x64',
      electronVersion: '42',
      chromeVersion: '141',
      details: expect.objectContaining({ serviceName: 'renderer' }),
      breadcrumbs: [{ createdAt: '2026-05-16T01:00:00.000Z', name: 'before_crash' }]
    } satisfies CrashReportCreateInput)
  })

  it('records a persist-failed no-capture span when accepted persistence rejects', async () => {
    const error = new Error('write failed')
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const record = vi.fn(() => Promise.reject(error))
    const testRuntime = runtime({ crashReports: { record } })

    recordProcessGoneCrash('renderer', 'renderer', 'crashed', 5, { name: 'Renderer' }, testRuntime)
    await Promise.resolve()

    expect(warn).toHaveBeenCalledWith('[crash-reporting] Failed to persist crash report:', error)
    expect(testRuntime.recordNoCaptureDiagnostic).toHaveBeenCalledWith(
      'process_gone_persist_failed',
      {
        source: 'renderer',
        processType: 'renderer',
        reason: 'crashed',
        exitCode: 5,
        details: { name: 'Renderer' },
        error
      }
    )
  })
})
