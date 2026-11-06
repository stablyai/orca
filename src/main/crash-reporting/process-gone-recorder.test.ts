import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appMetricsMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn((): unknown[] => [])
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: appMetricsMock
  }
}))
import { clearCrashBreadcrumbsForTest, getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

type CapturingSink = TracerSink & { records: unknown[]; flushMock: ReturnType<typeof vi.fn> }

/** Keeps tests off the real Crashpad directory; minidump pairing has its own suite. */
const noMinidump = async () => null
const attachDetails = async () => null

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

function event(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    ...overrides
  }
}

let sink: CapturingSink

beforeEach(() => {
  sink = capturingSink()
  setActiveSink(sink)
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

describe('recordProcessGoneCrash', () => {
  it('still persists the report when the forced trace flush fails', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    sink.flushMock.mockImplementation(() => {
      throw new Error('trace disk unavailable')
    })

    expect(() =>
      recordProcessGoneCrash(
        { record, attachDetails } as never,
        event(),
        new ProcessGoneDedupe(),
        noMinidump
      )
    ).not.toThrow()
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
  })

  it('still persists the report when the trace sink handoff fails', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    sink.push = () => {
      throw new Error('trace rotation failed')
    }

    expect(() =>
      recordProcessGoneCrash(
        { record, attachDetails } as never,
        event(),
        new ProcessGoneDedupe(),
        noMinidump
      )
    ).not.toThrow()
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
  })

  it('durably records a sanitized crash-report persistence failure', async () => {
    const persistError = Object.assign(
      new Error('EPERM at C:\\Users\\alice\\AppData\\Roaming\\Orca\\crash-reports.json'),
      { code: 'EPERM' }
    )
    const record = vi.fn().mockRejectedValue(persistError)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash(
      { record, attachDetails } as never,
      event(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    await vi.waitFor(() => {
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'crash_report_persist_failed',
            data: expect.objectContaining({ errorCode: 'EPERM' })
          })
        ])
      )
    })
    expect(sink.records).toHaveLength(2)
    expect(sink.records[1]).toEqual(
      expect.objectContaining({
        name: 'crash.breadcrumb',
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
    expect(JSON.stringify(sink.records)).not.toContain('alice')
    expect(sink.flushMock).toHaveBeenCalledTimes(2)
  })

  it('allows the same renderer crash to retry after persistence fails', async () => {
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ id: 'report-2' })
    const dedupe = new ProcessGoneDedupe()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash({ record, attachDetails } as never, event(), dedupe, noMinidump)
    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'crash_report_persist_failed' })])
      )
    )
    recordProcessGoneCrash({ record, attachDetails } as never, event(), dedupe, noMinidump)

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
  })
})

describe('minidump signature attachment', () => {
  const capturedRendererCheck = {
    filePath: '/dumps/reports/abc.dmp',
    sizeBytes: 2_400_000,
    signature: {
      checkMessage: '[0815/143022:FATAL:render_frame_impl.cc(4821)] Check failed: !is_detached_.',
      checkFile: 'render_frame_impl.cc',
      checkLine: 4821,
      processType: 'renderer',
      exceptionCode: 0x80000003,
      annotations: {}
    }
  }

  it('sanitizes dump annotations before writing the diagnostic span', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const attach = vi.fn().mockResolvedValue(null)
    const captured = {
      ...capturedRendererCheck,
      signature: {
        ...capturedRendererCheck.signature,
        checkMessage:
          '[FATAL:node.cc(123)] path=/Users/alice/private-project\nCheck failed: token=abc123'
      }
    }

    recordProcessGoneCrash(
      { record, attachDetails: attach } as never,
      event(),
      new ProcessGoneDedupe(),
      async () => captured
    )

    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce())
    expect(JSON.stringify(attach.mock.calls[0]?.[1])).not.toContain('alice')
    expect(JSON.stringify(attach.mock.calls[0]?.[1])).not.toContain('abc123')
    expect(JSON.stringify(sink.records)).not.toContain('alice')
    expect(JSON.stringify(sink.records)).not.toContain('abc123')
  })

  it('keeps the persisted report when minidump pairing throws', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()
    const releaseSpy = vi.spyOn(dedupe, 'release')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash({ record, attachDetails } as never, event(), dedupe, async () => {
      throw new Error('crashpad directory unreadable')
    })

    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'minidump_signature_attach_failed' })
        ])
      )
    )
    expect(releaseSpy).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'crash_report_persist_failed' })])
    )
  })
})
