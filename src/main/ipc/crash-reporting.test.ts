import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../shared/crash-reporting'

const { handlers, clipboardWriteTextMock, submitFeedbackMock } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  clipboardWriteTextMock: vi.fn(),
  submitFeedbackMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0-test' },
  clipboard: { writeText: clipboardWriteTextMock },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('./feedback', () => ({
  submitFeedback: submitFeedbackMock
}))

import { registerCrashReportingHandlers } from './crash-reporting'

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
    clipboardWriteTextMock.mockReset()
    submitFeedbackMock.mockReset()
    submitFeedbackMock.mockResolvedValue({ ok: true })
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

    expect(result).toEqual({ ok: true, report: sent })
    expect(submitFeedbackMock).toHaveBeenCalledWith({
      feedback: expect.stringContaining('extra [redacted-path]'),
      submissionType: 'crash',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    })
    expect(markSent).toHaveBeenCalledWith(pending.id)
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

    expect(result).toEqual({ ok: true, report: sent })
    expect(submitFeedbackMock).toHaveBeenCalledWith({
      feedback: expect.stringContaining('sent from startup prompt'),
      submissionType: 'crash',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
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
    expect(markSent).not.toHaveBeenCalled()
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
        appVersion: '1.0.0-test',
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
})
