import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listeners,
  recordCoalescedCrashBreadcrumbMock,
  recordCrashBreadcrumbMock,
  spanEndMock,
  startSpanMock
} = vi.hoisted(() => {
  const spanEndMock = vi.fn()
  return {
    listeners: new Map<string, (_event: unknown, args?: unknown) => void>(),
    recordCoalescedCrashBreadcrumbMock: vi.fn(),
    recordCrashBreadcrumbMock: vi.fn(),
    spanEndMock,
    startSpanMock: vi.fn(() => ({
      traceId: 'trace-id',
      spanId: 'span-id',
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      fail: vi.fn(),
      interrupt: vi.fn(),
      end: spanEndMock
    }))
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
    on: vi.fn((channel: string, listener: (_event: unknown, args?: unknown) => void) => {
      listeners.set(channel, listener)
    })
  }
}))

vi.mock('./feedback', () => ({
  submitFeedback: vi.fn()
}))

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  getCrashBreadcrumbSnapshot: vi.fn(() => []),
  recordCoalescedCrashBreadcrumb: (...args: unknown[]) =>
    recordCoalescedCrashBreadcrumbMock(...args),
  recordCrashBreadcrumb: (...args: unknown[]) => recordCrashBreadcrumbMock(...args)
}))

vi.mock('../observability', () => ({
  collectDiagnosticBundle: vi.fn(),
  getDiagnosticsStatus: vi.fn()
}))

vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: vi.fn()
}))

vi.mock('../observability/tracer', () => ({
  startSpan: startSpanMock
}))

import { registerCrashReportingHandlers } from './crash-reporting'

function registerHandlersWithStubStore(): void {
  registerCrashReportingHandlers({
    getLatestPending: vi.fn(),
    getById: vi.fn(),
    dismiss: vi.fn(),
    markSent: vi.fn(),
    listRecent: vi.fn(),
    record: vi.fn(),
    formatDiagnosticText: vi.fn()
  } as never)
}

function emitRendererBreadcrumb(args: unknown): void {
  listeners.get('crashReports:recordBreadcrumb')?.(null, args)
}

describe('renderer breadcrumb IPC routing', () => {
  beforeEach(() => {
    listeners.clear()
    recordCoalescedCrashBreadcrumbMock.mockReset()
    recordCoalescedCrashBreadcrumbMock.mockReturnValue({ suppressedSinceLast: 0 })
    recordCrashBreadcrumbMock.mockReset()
    startSpanMock.mockClear()
    spanEndMock.mockClear()
    registerHandlersWithStubStore()
  })

  it('sanitizes and coalesces renderer error breadcrumbs', () => {
    emitRendererBreadcrumb({
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

    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_error',
      data: { message: 'boom', count: 2, ok: true, empty: null },
      coalesceKey: expect.stringContaining('boom'),
      minIntervalMs: 30_000
    })
    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(startSpanMock).toHaveBeenCalledWith('renderer.breadcrumb', {
      attributes: {
        kind: 'crash-breadcrumb',
        'breadcrumb.name': 'renderer_error',
        'breadcrumb.data': { message: 'boom', count: 2, ok: true, empty: null }
      }
    })
    expect(spanEndMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces renderer rejection breadcrumbs by reason message', () => {
    emitRendererBreadcrumb({
      name: 'renderer_unhandled_rejection',
      data: { reasonType: 'string', reasonMessage: 'Remote connection dropped/reconnecting' }
    })

    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_unhandled_rejection',
      data: { reasonType: 'string', reasonMessage: 'Remote connection dropped/reconnecting' },
      coalesceKey: expect.stringContaining('Remote connection dropped/reconnecting'),
      minIntervalMs: 30_000
    })
    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('keeps the full sanitized message in the coalesce key', () => {
    const message = `${'same-prefix-'.repeat(12)}distinct-tail`

    emitRendererBreadcrumb({ name: 'renderer_error', data: { message } })

    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_error',
      data: { message },
      coalesceKey: expect.stringContaining(message),
      minIntervalMs: 30_000
    })
  })

  it('does not coalesce same-message errors from different source sites', () => {
    emitRendererBreadcrumb({
      name: 'renderer_error',
      data: { message: 'boom', filename: 'file:///first.js', lineno: 10, colno: 2 }
    })
    emitRendererBreadcrumb({
      name: 'renderer_error',
      data: { message: 'boom', filename: 'file:///second.js', lineno: 20, colno: 4 }
    })

    const [first, second] = recordCoalescedCrashBreadcrumbMock.mock.calls.map(
      ([args]) => args.coalesceKey
    )
    expect(first).not.toBe(second)
  })

  it('does not coalesce same-message rejections from different stacks', () => {
    emitRendererBreadcrumb({
      name: 'renderer_unhandled_rejection',
      data: { reasonMessage: 'boom', reasonStack: 'Error: boom\n at first' }
    })
    emitRendererBreadcrumb({
      name: 'renderer_unhandled_rejection',
      data: { reasonMessage: 'boom', reasonStack: 'Error: boom\n at second' }
    })

    const [first, second] = recordCoalescedCrashBreadcrumbMock.mock.calls.map(
      ([args]) => args.coalesceKey
    )
    expect(first).not.toBe(second)
  })

  it('records message-less errors without coalescing unrelated failures', () => {
    emitRendererBreadcrumb({
      name: 'renderer_unhandled_rejection',
      data: { reasonType: 'Object' }
    })

    expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith('renderer_unhandled_rejection', {
      reasonType: 'Object'
    })
    expect(recordCoalescedCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(startSpanMock).toHaveBeenCalledTimes(1)
  })

  it('uses the Error object message when an error event has no message', () => {
    emitRendererBreadcrumb({
      name: 'renderer_error',
      data: { message: '', errorMessage: 'fallback failure' }
    })

    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_error',
      data: { message: '', errorMessage: 'fallback failure' },
      coalesceKey: expect.stringContaining('fallback failure'),
      minIntervalMs: 30_000
    })
  })

  it('does not emit durable trace spans for errors suppressed by coalescing', () => {
    recordCoalescedCrashBreadcrumbMock
      .mockReturnValueOnce({ suppressedSinceLast: 0 })
      .mockReturnValue(undefined)

    for (let index = 0; index < 1_000; index += 1) {
      emitRendererBreadcrumb({ name: 'renderer_error', data: { message: 'storm' } })
    }

    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledTimes(1_000)
    expect(startSpanMock).toHaveBeenCalledTimes(1)
    expect(spanEndMock).toHaveBeenCalledTimes(1)
  })

  it('includes the suppressed count when durable tracing resumes', () => {
    recordCoalescedCrashBreadcrumbMock.mockReturnValueOnce({ suppressedSinceLast: 999 })

    emitRendererBreadcrumb({ name: 'renderer_error', data: { message: 'storm' } })

    expect(startSpanMock).toHaveBeenCalledWith('renderer.breadcrumb', {
      attributes: {
        kind: 'crash-breadcrumb',
        'breadcrumb.name': 'renderer_error',
        'breadcrumb.data': { message: 'storm', suppressedSinceLast: 999 }
      }
    })
  })

  // Why: park-churn notices are per-tab but the ring is process-wide, so many
  // tabs churning at once would otherwise evict the pre-crash trail.
  it('coalesces park-verdict churn notices by name across tabs', () => {
    emitRendererBreadcrumb({
      name: 'terminal_park_verdict_churn',
      data: { tabId: 'tab-1', flips: 12, elapsedMs: 8 }
    })
    emitRendererBreadcrumb({
      name: 'terminal_park_verdict_churn',
      data: { tabId: 'tab-2', flips: 12, elapsedMs: 9 }
    })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledTimes(2)
    for (const call of recordCoalescedCrashBreadcrumbMock.mock.calls) {
      expect(call[0]).toMatchObject({ coalesceKey: 'terminal_park_verdict_churn' })
    }
  })

  // Why: every hidden pane is 0x0, so one post-reload reattach wave exhausts
  // the fit budget once per mounted pane inside ~60ms. Windows crash
  // F0BKR84AHEH lost 26-90% of its 30-entry ring to two such bursts.
  it('coalesces fit-retry exhaustion by name, not by pane', () => {
    emitRendererBreadcrumb({
      name: 'terminal_safe_fit_retry_exhausted',
      data: { paneId: 1, leafId: 'leaf-a' }
    })
    emitRendererBreadcrumb({
      name: 'terminal_safe_fit_retry_exhausted',
      data: { paneId: 1, leafId: 'leaf-b' }
    })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledTimes(2)
    for (const call of recordCoalescedCrashBreadcrumbMock.mock.calls) {
      expect(call[0]).toMatchObject({ coalesceKey: 'terminal_safe_fit_retry_exhausted' })
    }
  })

  // Why kind-scoped: a routine post-wake atlas reset must never suppress the
  // context-loss crumb that says the driver gave up on this renderer.
  it('coalesces WebGL diagnostics per kind so one kind cannot mask another', () => {
    emitRendererBreadcrumb({
      name: 'terminal_webgl_diagnostic',
      data: { kind: 'webgl-context-loss', paneId: 1 }
    })
    emitRendererBreadcrumb({
      name: 'terminal_webgl_diagnostic',
      data: { kind: 'webgl-atlas-reset', managers: 3 }
    })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(
      recordCoalescedCrashBreadcrumbMock.mock.calls.map(
        (call) => (call[0] as { coalesceKey: string }).coalesceKey
      )
    ).toEqual([
      'terminal_webgl_diagnostic:webgl-context-loss',
      'terminal_webgl_diagnostic:webgl-atlas-reset'
    ])
  })

  it('coalesces atlas resets per trigger reason', () => {
    emitRendererBreadcrumb({
      name: 'terminal_webgl_diagnostic',
      data: { kind: 'webgl-atlas-reset', reason: 'terminal-output' }
    })
    emitRendererBreadcrumb({
      name: 'terminal_webgl_diagnostic',
      data: { kind: 'webgl-atlas-reset', reason: 'system-resume' }
    })

    expect(
      recordCoalescedCrashBreadcrumbMock.mock.calls.map(
        (call) => (call[0] as { coalesceKey: string }).coalesceKey
      )
    ).toEqual([
      'terminal_webgl_diagnostic:webgl-atlas-reset:terminal-output',
      'terminal_webgl_diagnostic:webgl-atlas-reset:system-resume'
    ])
  })

  // Why: the renderer guard is once per tab-id/verdict, so one stale worktree
  // map can emit enough crumbs to evict the pre-crash trail.
  it('coalesces duplicate-tab-owner notices across tabs', () => {
    emitRendererBreadcrumb({
      name: 'terminal_tab_id_owned_by_multiple_worktrees',
      data: { ownerCount: 2, resolvedToActiveWorktree: true }
    })
    emitRendererBreadcrumb({
      name: 'terminal_tab_id_owned_by_multiple_worktrees',
      data: { ownerCount: 3, resolvedToActiveWorktree: true }
    })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledTimes(2)
    for (const call of recordCoalescedCrashBreadcrumbMock.mock.calls) {
      expect(call[0]).toMatchObject({
        coalesceKey: 'terminal_tab_id_owned_by_multiple_worktrees:true'
      })
    }
  })

  // Why flag-scoped: coalescing keeps only the newest payload, and the verdict
  // flips under a persisting duplicate, so one would erase the other.
  it('keeps a non-converging duplicate-tab-owner notice out of the converging one', () => {
    emitRendererBreadcrumb({
      name: 'terminal_tab_id_owned_by_multiple_worktrees',
      data: { ownerCount: 2, resolvedToActiveWorktree: false }
    })
    emitRendererBreadcrumb({
      name: 'terminal_tab_id_owned_by_multiple_worktrees',
      data: { ownerCount: 2, resolvedToActiveWorktree: true }
    })

    expect(
      recordCoalescedCrashBreadcrumbMock.mock.calls.map(
        (call) => (call[0] as { coalesceKey: string }).coalesceKey
      )
    ).toEqual([
      'terminal_tab_id_owned_by_multiple_worktrees:false',
      'terminal_tab_id_owned_by_multiple_worktrees:true'
    ])
  })

  it('records non-error renderer breadcrumbs without coalescing', () => {
    emitRendererBreadcrumb({ name: 'renderer_bootstrap_started', data: { dev: true } })

    expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith('renderer_bootstrap_started', {
      dev: true
    })
    expect(recordCoalescedCrashBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('ignores renderer breadcrumbs without a string name', () => {
    emitRendererBreadcrumb({ name: 123, data: { message: 'boom' } })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(recordCoalescedCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(startSpanMock).not.toHaveBeenCalled()
  })
})
