import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCrashBreadcrumbsForTest, getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

type CapturingSink = TracerSink & { records: unknown[]; flushMock: ReturnType<typeof vi.fn> }

function capturingSink(): CapturingSink {
  const records: unknown[] = []
  const flushMock = vi.fn()
  return {
    records,
    flushMock,
    push: (record) => records.push(record),
    flush: flushMock,
    close: vi.fn()
  }
}

let sink: CapturingSink

beforeEach(() => {
  sink = capturingSink()
  setActiveSink(sink)
  clearCrashBreadcrumbsForTest()
})

afterEach(() => {
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
})

describe('recordDurableCrashBreadcrumb', () => {
  it('records, traces, and flushes a sanitized crash breadcrumb', () => {
    recordDurableCrashBreadcrumb('process_gone_suppressed', {
      source: 'renderer',
      path: 'C:\\Users\\alice\\project'
    })

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: { source: 'renderer', path: '[redacted-path]' }
      })
    ])
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        attributes: expect.objectContaining({
          kind: 'crash-breadcrumb',
          'breadcrumb.name': 'process_gone_suppressed'
        }),
        exit: { _tag: 'Success' }
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('records persistence failures as failed, flushed spans', () => {
    recordDurableCrashBreadcrumb(
      'crash_report_persist_failed',
      { errorCode: 'EPERM' },
      'EPERM at C:\\Users\\alice\\AppData\\Roaming\\Orca'
    )

    expect(sink.records).toEqual([
      expect.objectContaining({
        exit: expect.objectContaining({ _tag: 'Failure', cause: expect.stringContaining('EPERM') })
      })
    ])
    expect(JSON.stringify(sink.records)).not.toContain('alice')
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })
})
