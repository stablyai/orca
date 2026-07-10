import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../shared/crash-reporting'

const {
  handlers,
  listeners,
  clipboardWriteTextMock,
  collectDiagnosticBundleMock,
  getDiagnosticsStatusMock,
  recordCrashBreadcrumbMock,
  resolveDiagnosticOrcaChannelMock,
  spanEndMock,
  startSpanMock,
  submitFeedbackMock
} = vi.hoisted(() => {
  const spanEndMock = vi.fn()
  return {
    handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
    listeners: new Map<string, (_event: unknown, args?: unknown) => void>(),
    clipboardWriteTextMock: vi.fn(),
    collectDiagnosticBundleMock: vi.fn(),
    getDiagnosticsStatusMock: vi.fn(),
    recordCrashBreadcrumbMock: vi.fn(),
    resolveDiagnosticOrcaChannelMock: vi.fn(),
    spanEndMock,
    startSpanMock: vi.fn(() => ({
      traceId: 'trace-id',
      spanId: 'span-id',
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      fail: vi.fn(),
      interrupt: vi.fn(),
      end: spanEndMock
    })),
    submitFeedbackMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  clipboard: { writeText: clipboardWriteTextMock },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
    on: vi.fn((channel: string, listener: (_event: unknown, args?: unknown) => void) => {
      listeners.set(channel, listener)
    })
  }
}))

vi.mock('./feedback', () => ({
  submitFeedback: submitFeedbackMock
}))

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  getCrashBreadcrumbSnapshot: vi.fn(() => []),
  recordCrashBreadcrumb: (...args: unknown[]) => recordCrashBreadcrumbMock(...args)
}))

vi.mock('../observability', () => ({
  collectDiagnosticBundle: collectDiagnosticBundleMock,
  getDiagnosticsStatus: getDiagnosticsStatusMock
}))

vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: resolveDiagnosticOrcaChannelMock
}))

vi.mock('../observability/tracer', () => ({
  startSpan: startSpanMock
}))

import {
  _getCrashReportingStateSizesForTests,
  _resetRendererErrorReportDedupeForTests,
  registerCrashReportingHandlers
} from './crash-reporting'

function diagnosticBundle(): ReturnType<typeof collectDiagnosticBundleMock> {
  return {
    bundleSubmissionId: 'bundleabcdefghijklmnop',
    payload: '{"type":"bundle-header"}\n',
    bytes: 25,
    spanCount: 1
  }
}

function report(
  status: CrashReportRecord['status'] = 'pending',
  id = 'crash-1'
): CrashReportRecord {
  return {
    id,
    createdAt: '2026-05-16T01:00:00.000Z',
    status,
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.0.0',
    platform: process.platform,
    osRelease: 'test',
    arch: process.arch,
    electronVersion: '41',
    chromeVersion: '141',
    details: {}
  }
}

describe('registerCrashReportingHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    clipboardWriteTextMock.mockReset()
    collectDiagnosticBundleMock.mockReset()
    collectDiagnosticBundleMock.mockReturnValue(diagnosticBundle())
    getDiagnosticsStatusMock.mockReset()
    getDiagnosticsStatusMock.mockReturnValue({
      localFileEnabled: true,
      otlpEnabled: false,
      bundleEnabled: true,
      otlpStatus: 'Disabled',
      traceFilePath: '/tmp/main.trace.ndjson',
      traceFamilySize: 25
    })
    resolveDiagnosticOrcaChannelMock.mockReset()
    resolveDiagnosticOrcaChannelMock.mockReturnValue('stable')
    startSpanMock.mockClear()
    spanEndMock.mockClear()
    submitFeedbackMock.mockReset()
    recordCrashBreadcrumbMock.mockReset()
    submitFeedbackMock.mockResolvedValue({ ok: true })
    _resetRendererErrorReportDedupeForTests()
  })

  it('copies the latest pending diagnostic text to the clipboard', async () => {
    const latest = report()
    registerCrashReportingHandlers({
      getById: vi.fn(async () => latest),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [latest]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:copyLatestDiagnostics')?.(null, {
      notes: 'extra /Users/alice/project'
    })

    expect(result).toEqual({ ok: true })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('[Crash Report]'))
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      expect.stringContaining('extra [redacted-path]')
    )
  })

  it('copies an uncaptured crash report when the caller intentionally omits reportId', async () => {
    const pending = report('pending', 'crash-late-pending')
    const listRecent = vi.fn(async () => [pending])
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent,
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:copyLatestDiagnostics')?.(null, {
      notes: 'after opening /Users/alice/project'
    })

    expect(result).toEqual({ ok: true })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('not captured'))
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('[redacted-path]'))
    expect(clipboardWriteTextMock).not.toHaveBeenCalledWith(
      expect.stringContaining('crash-late-pending')
    )
    expect(listRecent).not.toHaveBeenCalled()
  })

  it('returns dismissed unsent reports for the manual Help menu entry', async () => {
    const dismissed = report('dismissed', 'crash-help-menu')
    registerCrashReportingHandlers({
      getById: vi.fn(async () => dismissed),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [report('sent', 'crash-sent'), dismissed]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    await expect(handlers.get('crashReports:getLatestPending')?.(null)).resolves.toBeNull()
    await expect(handlers.get('crashReports:getLatestReport')?.(null)).resolves.toEqual(dismissed)
  })

  it('submits a pending report through feedback and marks it sent', async () => {
    const pending = report('pending', 'crash-pending')
    const sent = report('sent', pending.id)
    const markSent = vi.fn(async () => sent)
    registerCrashReportingHandlers({
      getById: vi.fn(async () => pending),
      dismiss: vi.fn(),
      markSent,
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [pending]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      reportId: pending.id,
      notes: 'extra /Users/alice/project',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: sent,
      diagnosticBundle: {
        status: 'attached',
        bundleSubmissionId: 'bundleabcdefghijklmnop',
        bytes: 25,
        spanCount: 1
      }
    })
    expect(submitFeedbackMock).toHaveBeenCalledWith({
      feedback: expect.stringContaining('Status: attached'),
      submissionType: 'crash',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null,
      diagnosticBundle: {
        bundleSubmissionId: 'bundleabcdefghijklmnop',
        content: diagnosticBundle().payload,
        bytes: 25,
        spanCount: 1
      }
    })
    expect(markSent).toHaveBeenCalledWith(pending.id)
  })

  it('submits an uncaptured Help menu crash report with an attached diagnostic bundle', async () => {
    const pending = report('pending', 'crash-late-pending')
    const markSent = vi.fn()
    const listRecent = vi.fn(async () => [pending])
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent,
      markDismissedSent: vi.fn(),
      listRecent,
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      notes: 'blank window after opening /Users/alice/project',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: null,
      diagnosticBundle: {
        status: 'attached',
        bundleSubmissionId: 'bundleabcdefghijklmnop',
        bytes: 25,
        spanCount: 1
      }
    })
    expect(collectDiagnosticBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({ lookbackMinutes: 3 * 24 * 60, orcaChannel: 'stable' })
    )
    expect(submitFeedbackMock).toHaveBeenCalledWith({
      feedback: expect.stringContaining('Report ID: not captured'),
      submissionType: 'crash',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null,
      diagnosticBundle: {
        bundleSubmissionId: 'bundleabcdefghijklmnop',
        content: diagnosticBundle().payload,
        bytes: 25,
        spanCount: 1
      }
    })
    expect(submitFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ feedback: expect.stringContaining('Status: attached') })
    )
    expect(submitFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ feedback: expect.stringContaining('[redacted-path]') })
    )
    expect(markSent).not.toHaveBeenCalled()
    expect(listRecent).not.toHaveBeenCalled()
  })

  it('uploads crash logs by default after Send Report', async () => {
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      notes: 'manual report',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: null,
      diagnosticBundle: {
        status: 'attached',
        bundleSubmissionId: 'bundleabcdefghijklmnop',
        bytes: 25,
        spanCount: 1
      }
    })
    expect(submitFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: expect.stringContaining('Status: attached'),
        diagnosticBundle: {
          bundleSubmissionId: 'bundleabcdefghijklmnop',
          content: diagnosticBundle().payload,
          bytes: 25,
          spanCount: 1
        }
      })
    )
  })

  it('submits the crash report without logs when the user excludes diagnostic logs', async () => {
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      notes: 'manual report',
      includeDiagnosticLogs: false,
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: null,
      diagnosticBundle: {
        status: 'not_uploaded',
        reason: 'diagnostic log upload skipped by user'
      }
    })
    expect(collectDiagnosticBundleMock).not.toHaveBeenCalled()
    expect(submitFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: expect.stringContaining('diagnostic log upload skipped by user')
      })
    )
  })

  it('still submits an uncaptured crash report when the diagnostic bundle cannot be collected', async () => {
    collectDiagnosticBundleMock.mockImplementation(() => {
      throw new Error('collect failed')
    })
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      notes: 'manual report',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: null,
      diagnosticBundle: {
        status: 'not_uploaded',
        reason: 'collect failed'
      }
    })
    expect(submitFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ feedback: expect.stringContaining('Status: not uploaded') })
    )
  })

  it('submits a dismissed startup prompt through feedback and marks it sent', async () => {
    const dismissed = report('dismissed', 'crash-dismissed')
    const sent = report('sent', dismissed.id)
    const markDismissedSent = vi.fn(async () => sent)
    registerCrashReportingHandlers({
      getById: vi.fn(async () => dismissed),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent,
      listRecent: vi.fn(async () => []),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      reportId: dismissed.id,
      notes: 'sent from startup prompt',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: sent,
      diagnosticBundle: {
        status: 'attached',
        bundleSubmissionId: 'bundleabcdefghijklmnop',
        bytes: 25,
        spanCount: 1
      }
    })
    expect(submitFeedbackMock).toHaveBeenCalledWith({
      feedback: expect.stringContaining('sent from startup prompt'),
      submissionType: 'crash',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null,
      diagnosticBundle: {
        bundleSubmissionId: 'bundleabcdefghijklmnop',
        content: diagnosticBundle().payload,
        bytes: 25,
        spanCount: 1
      }
    })
    expect(markDismissedSent).toHaveBeenCalledWith(dismissed.id)
  })

  it('dismisses a pending report locally without any network submission', async () => {
    const latest = report('pending', 'crash-dismiss')
    const dismissed = report('dismissed', latest.id)
    const dismiss = vi.fn(async () => dismissed)
    registerCrashReportingHandlers({
      getById: vi.fn(async () => latest),
      dismiss,
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [latest]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:dismiss')?.(null, {
      reportId: latest.id
    })

    expect(result).toEqual(dismissed)
    expect(dismiss).toHaveBeenCalledWith(latest.id)
    expect(submitFeedbackMock).not.toHaveBeenCalled()
  })

  it('keeps a pending report available if feedback submission fails', async () => {
    const pending = report('pending', 'crash-failed')
    const markSent = vi.fn()
    submitFeedbackMock.mockResolvedValue({
      ok: false,
      status: 500,
      error: 'status 500'
    })
    registerCrashReportingHandlers({
      getById: vi.fn(async () => pending),
      dismiss: vi.fn(),
      markSent,
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [pending]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      reportId: pending.id,
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    })

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: 'status 500',
      report: pending
    })
    expect(submitFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosticBundle: {
          bundleSubmissionId: 'bundleabcdefghijklmnop',
          content: diagnosticBundle().payload,
          bytes: 25,
          spanCount: 1
        }
      })
    )
    expect(markSent).not.toHaveBeenCalled()
  })

  it('bounds submitted report ids by evicting the oldest successful sends', async () => {
    registerCrashReportingHandlers({
      getById: vi.fn(async (reportId: string) => report('pending', reportId)),
      dismiss: vi.fn(),
      markSent: vi.fn(async (reportId: string) => report('sent', reportId)),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    for (let i = 0; i < 260; i += 1) {
      await handlers.get('crashReports:submit')?.(null, {
        reportId: `crash-${i}`,
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })
    }

    expect(_getCrashReportingStateSizesForTests().submittedReportIds).toBe(256)
  })

  it('records a deduped renderer error boundary report through the crash store', async () => {
    const recorded = report('pending', 'react-render')
    const recordMock = vi.fn(async () => recorded)
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    const args = {
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      errorName: 'TypeError',
      errorMessage: 'Cannot read /Users/alice/project/token=abc123',
      errorStack: 'TypeError: nope\n    at /Users/alice/project/App.tsx:12:1',
      componentStack: 'at Terminal\nat App',
      activeView: 'terminal',
      activeModal: 'none',
      activeTabType: 'terminal',
      activeRightSidebarTab: 'source-control',
      hasActiveWorktree: true
    }

    await expect(handlers.get('crashReports:recordRendererError')?.(null, args)).resolves.toEqual({
      ok: true,
      report: recorded,
      deduped: false
    })
    await expect(handlers.get('crashReports:recordRendererError')?.(null, args)).resolves.toEqual({
      ok: true,
      report: null,
      deduped: true
    })

    expect(recordMock).toHaveBeenCalledTimes(1)
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'renderer',
        processType: 'react-render',
        reason: 'react-error-boundary',
        exitCode: null,
        appVersion: '1.2.3-test',
        details: expect.objectContaining({
          boundary_id: 'terminal.workbench',
          surface: 'terminal-workbench',
          error_name: 'TypeError',
          error_message: 'Cannot read /Users/alice/project/token=abc123',
          active_view: 'terminal',
          active_modal: 'none',
          active_tab_type: 'terminal',
          right_sidebar_tab: 'source-control',
          has_active_worktree: true
        })
      })
    )
  })

  it('rejects invalid renderer error boundary surfaces', async () => {
    const recordMock = vi.fn()
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        boundaryId: 'terminal.workbench',
        surface: 'unknown',
        errorName: 'TypeError',
        errorMessage: 'nope'
      })
    ).resolves.toEqual({ ok: false, error: 'Invalid renderer error report.' })
    expect(recordMock).not.toHaveBeenCalled()
  })

  it('bounds renderer error dedupe keys by evicting the oldest unique reports', async () => {
    let recordCount = 0
    const recordMock = vi.fn(async () => report('pending', `react-render-${recordCount++}`))
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    const baseArgs = {
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      errorName: 'TypeError',
      componentStack: 'at Terminal'
    }

    for (let i = 0; i < 260; i += 1) {
      await handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: `unique-render-error-${i}`
      })
    }

    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: 'unique-render-error-0'
      })
    ).resolves.toEqual({
      ok: true,
      report: expect.objectContaining({ id: 'react-render-260' }),
      deduped: false
    })
    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: 'unique-render-error-259'
      })
    ).resolves.toEqual({
      ok: true,
      report: null,
      deduped: true
    })

    expect(recordMock).toHaveBeenCalledTimes(261)
  })

  it('records sanitized renderer breadcrumbs', () => {
    registerCrashReportingHandlers({
      getLatestPending: vi.fn(),
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      listRecent: vi.fn(),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    listeners.get('crashReports:recordBreadcrumb')?.(null, {
      name: 'renderer_error',
      data: {
        message: 'boom',
        count: 2,
        ok: true,
        empty: null,
        badNumber: Number.POSITIVE_INFINITY,
        object: { ignored: true }
      }
    })

    expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith('renderer_error', {
      message: 'boom',
      count: 2,
      ok: true,
      empty: null
    })
    expect(startSpanMock).toHaveBeenCalledWith('renderer.breadcrumb', {
      attributes: {
        kind: 'crash-breadcrumb',
        'breadcrumb.name': 'renderer_error',
        'breadcrumb.data': {
          message: 'boom',
          count: 2,
          ok: true,
          empty: null
        }
      }
    })
    expect(spanEndMock).toHaveBeenCalledTimes(1)
  })

  it('ignores renderer breadcrumbs without a string name', () => {
    registerCrashReportingHandlers({
      getLatestPending: vi.fn(),
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      listRecent: vi.fn(),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    listeners.get('crashReports:recordBreadcrumb')?.(null, {
      name: 123,
      data: { message: 'boom' }
    })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(startSpanMock).not.toHaveBeenCalled()
  })
})
