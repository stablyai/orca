import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_CREDIT_STALL_MS,
  TERMINAL_PROGRESS_MAX_PENDING,
  TERMINAL_PROGRESS_REPORT_INTERVAL_MS,
  TerminalStreamProgress,
  TerminalStreamProgressReporter
} from './terminal-stream-progress'

describe('terminal stream progress reports', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does no timer work for accepted traffic and coalesces refused input', () => {
    const emit = vi.fn()
    const reporter = new TerminalStreamProgressReporter(emit)
    const progress = new TerminalStreamProgress(reporter, { side: 'client', streamId: 7 })
    for (let index = 0; index < 1_000; index++) {
      progress.count('ipcInputAccepted')
    }
    expect(vi.getTimerCount()).toBe(0)
    for (let index = 0; index < 1_000; index++) {
      progress.count('ipcInputRefused')
      progress.report('ipc_transport_refused')
    }
    expect(vi.getTimerCount()).toBe(1)
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      counters: { ipcInputAccepted: 1_000, ipcInputRefused: 1_000 },
      reasons: ['ipc_transport_refused']
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('anchors the credit deadline and captures current counters without reading payloads', () => {
    const emit = vi.fn()
    const reporter = new TerminalStreamProgressReporter(emit)
    let pendingBytes = 10
    const progress = new TerminalStreamProgress(
      reporter,
      { side: 'host', requestId: 'request', streamId: 3 },
      () => ({ pendingBytes })
    )
    progress.creditBlocked()
    vi.advanceTimersByTime(TERMINAL_CREDIT_STALL_MS - 1)
    pendingBytes = 100
    progress.creditBlocked()
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      observedForMs: TERMINAL_CREDIT_STALL_MS,
      snapshot: { pendingBytes: 100 },
      reasons: ['credit_blocked']
    })
  })

  it('cancels brief blockage and intentional pause without reporting recovery', () => {
    const emit = vi.fn()
    const reporter = new TerminalStreamProgressReporter(emit)
    const progress = new TerminalStreamProgress(reporter, { side: 'host', streamId: 1 })
    progress.creditBlocked()
    progress.creditRestored()
    expect(vi.getTimerCount()).toBe(0)
    progress.creditBlocked()
    vi.advanceTimersByTime(TERMINAL_CREDIT_STALL_MS)
    progress.creditCancelled()
    vi.advanceTimersByTime(TERMINAL_PROGRESS_REPORT_INTERVAL_MS)
    expect(emit).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves each threshold when refusal and credit reports overlap', () => {
    const emit = vi.fn()
    const reporter = new TerminalStreamProgressReporter(emit)
    const progress = new TerminalStreamProgress(reporter, { side: 'host', streamId: 2 })
    progress.report('input_refused')
    vi.advanceTimersByTime(500)
    progress.creditBlocked()
    vi.advanceTimersByTime(500)
    expect(emit.mock.calls[0]?.[0].reasons).toEqual(['input_refused'])
    vi.advanceTimersByTime(TERMINAL_PROGRESS_REPORT_INTERVAL_MS)
    expect(emit.mock.calls[1]?.[0].reasons).toEqual(['credit_blocked'])
    expect(emit.mock.calls[1]?.[0].observedForMs).toBe(10_500)
  })

  it('bounds pending records and emission across connections', () => {
    const emit = vi.fn()
    const reporter = new TerminalStreamProgressReporter(emit)
    const streams = Array.from({ length: TERMINAL_PROGRESS_MAX_PENDING + 10 }, (_, streamId) =>
      new TerminalStreamProgress(reporter, { side: 'host', requestId: `request-${streamId}`, streamId })
    )
    for (const progress of streams) {
      progress.report('input_refused')
    }
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0]?.[0].omittedReports).toBe(10)
    vi.advanceTimersByTime(TERMINAL_PROGRESS_REPORT_INTERVAL_MS - 1)
    expect(emit).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledTimes(2)
    for (const progress of streams) {
      progress.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates sink failures and leaves disposed streams silent', () => {
    const emit = vi.fn(() => { throw new Error('sink unavailable') })
    const reporter = new TerminalStreamProgressReporter(emit)
    const progress = new TerminalStreamProgress(reporter, { side: 'host', streamId: 4 })
    progress.report('ack_rejected')
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
    progress.creditBlocked()
    progress.dispose()
    progress.report('input_refused')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule diagnostics when tracing is disabled', () => {
    const reporter = new TerminalStreamProgressReporter(vi.fn(), () => false)
    const progress = new TerminalStreamProgress(reporter, { side: 'host', streamId: 8 })
    progress.creditBlocked()
    progress.report('input_refused')
    expect(vi.getTimerCount()).toBe(0)
  })
})
