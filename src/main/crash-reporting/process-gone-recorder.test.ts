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

import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'
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
  it('durably records when the crash report store is unavailable', () => {
    recordProcessGoneCrash(null, event(), new ProcessGoneDedupe())

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'crash_report_store_unavailable',
        data: expect.objectContaining({
          source: 'renderer',
          expectedTeardown: 'none'
        })
      })
    ])
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('durably records why an expected renderer teardown was suppressed', () => {
    const record = vi.fn()

    recordProcessGoneCrash(
      { record } as never,
      event({ reason: 'killed', exitCode: 1, expectedTeardown: 'renderer-reload' }),
      new ProcessGoneDedupe()
    )

    expect(record).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ expectedTeardown: 'renderer-reload' })
      })
    ])
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        attributes: expect.objectContaining({
          'breadcrumb.name': 'process_gone_suppressed'
        })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('durably suppresses a Linux namespace-encoded renderer SIGTERM', () => {
    const record = vi.fn()

    withStubbedPlatform('linux', () => {
      recordProcessGoneCrash(
        { record } as never,
        event({ reason: 'killed', exitCode: 61696 }),
        new ProcessGoneDedupe()
      )
    })

    expect(record).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({
          source: 'renderer',
          reason: 'killed',
          exitCode: 61696,
          expectedTeardown: 'none'
        })
      })
    ])
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        attributes: expect.objectContaining({
          'breadcrumb.name': 'process_gone_suppressed',
          'breadcrumb.data': expect.objectContaining({ exitCode: 61696 })
        })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('keeps suppressed renderer evidence scoped to its renderer', () => {
    const dedupe = new ProcessGoneDedupe()
    const suppressed = (webContentsId: number) =>
      event({ reason: 'killed', exitCode: 1, expectedTeardown: 'renderer-reload', webContentsId })

    recordProcessGoneCrash({ record: vi.fn() } as never, suppressed(11), dedupe)
    recordProcessGoneCrash({ record: vi.fn() } as never, suppressed(22), dedupe)

    expect(getCrashBreadcrumbSnapshot('renderer:11')).toEqual([
      expect.objectContaining({ origin: 'renderer:11' })
    ])
    expect(getCrashBreadcrumbSnapshot('renderer:22')).toEqual([
      expect.objectContaining({ origin: 'renderer:22' })
    ])
  })

  it('coalesces a recoverable-service crash loop instead of flushing every event', () => {
    const record = vi.fn()
    const dedupe = new ProcessGoneDedupe()
    const networkServiceCrash = event({
      source: 'child',
      processType: 'Utility',
      reason: 'crashed',
      expectedTeardown: 'none',
      details: { serviceName: 'network.mojom.NetworkService', type: 'Utility' }
    })

    // Observed peak in a real diagnostic bundle: 1459 suppressed crashes in one minute.
    for (let i = 0; i < 1_459; i++) {
      recordProcessGoneCrash({ record } as never, networkServiceCrash, dedupe)
    }

    expect(record).not.toHaveBeenCalled()
    expect(sink.records).toHaveLength(1)
    expect(sink.flushMock).toHaveBeenCalledOnce()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ serviceName: 'network.mojom.NetworkService' })
      })
    ])
  })

  it('keeps the pre-crash breadcrumb trail through a crash loop', () => {
    const dedupe = new ProcessGoneDedupe()
    recordCrashBreadcrumb('renderer_error', { message: 'boom' })

    for (let i = 0; i < 1_459; i++) {
      recordProcessGoneCrash(
        { record: vi.fn() } as never,
        event({
          source: 'child',
          processType: 'Utility',
          reason: 'crashed',
          details: { serviceName: 'network.mojom.NetworkService' }
        }),
        dedupe
      )
    }

    // Why: the ring holds 30 entries, so an uncoalesced loop evicts every real breadcrumb.
    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.name)).toEqual([
      'renderer_error',
      'process_gone_suppressed'
    ])
  })

  it('reports how many repeats a coalesced suppression stands for', () => {
    vi.useFakeTimers()
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = event({
      source: 'child',
      processType: 'Utility',
      reason: 'crashed',
      details: { serviceName: 'network.mojom.NetworkService' }
    })

    for (let i = 0; i < 700; i++) {
      recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash, dedupe)
    }
    vi.advanceTimersByTime(30_000)
    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash, dedupe)

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({ name: 'process_gone_suppressed' }),
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ suppressedSinceLast: 699 })
      })
    ])
    // Why: the ring gets this count from the store itself, so only the span proves
    // the exported telemetry carries it too.
    expect(sink.records).toEqual([
      expect.objectContaining({ name: 'crash.breadcrumb' }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'breadcrumb.data': expect.objectContaining({ suppressedSinceLast: 699 })
        })
      })
    ])
  })

  it('keeps suppressions with different exit codes separate', () => {
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = (exitCode: number) =>
      event({
        source: 'child',
        processType: 'Utility',
        reason: 'crashed',
        exitCode,
        details: { serviceName: 'network.mojom.NetworkService' }
      })

    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash(11), dedupe)
    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash(139), dedupe)

    // Why: a clean shutdown code and a segfault are different failures; collapsing
    // them would hide the second behind the first for a full window.
    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.exitCode)).toEqual([
      11, 139
    ])
  })

  it('never lets one recoverable service suppress another service evidence', () => {
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = (serviceName: string) =>
      event({
        source: 'child',
        processType: 'Utility',
        reason: 'crashed',
        details: { serviceName }
      })

    recordProcessGoneCrash(
      { record: vi.fn() } as never,
      utilityCrash('network.mojom.NetworkService'),
      dedupe
    )
    recordProcessGoneCrash(
      { record: vi.fn() } as never,
      utilityCrash('audio.mojom.AudioService'),
      dedupe
    )

    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.serviceName)).toEqual([
      'network.mojom.NetworkService',
      'audio.mojom.AudioService'
    ])
  })

  it('derives the crashed-process-absent flag from the crashed process type', async () => {
    // Binds event.processType through to the diagnostics bucket check: a live
    // Utility survivor clears the flag for a Utility crash but not a renderer one.
    appMetricsMock.mockReturnValue([
      { pid: 77, type: 'Utility', memory: { workingSetSize: 1024 * 50 } }
    ])

    const rendererRecord = vi.fn().mockResolvedValue({ id: 'report-r' })
    recordProcessGoneCrash({ record: rendererRecord } as never, event(), new ProcessGoneDedupe())
    await vi.waitFor(() => expect(rendererRecord).toHaveBeenCalledOnce())
    expect(rendererRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ processMetricsCrashedProcessAbsent: true })
      })
    )

    const utilityRecord = vi.fn().mockResolvedValue({ id: 'report-u' })
    recordProcessGoneCrash(
      { record: utilityRecord } as never,
      event({ source: 'child', processType: 'Utility', details: { type: 'Utility' } }),
      new ProcessGoneDedupe()
    )
    await vi.waitFor(() => expect(utilityRecord).toHaveBeenCalledOnce())
    const utilityDetails = (utilityRecord.mock.calls[0][0] as { details: Record<string, unknown> })
      .details
    expect(utilityDetails.processMetricsUtilityCount).toBe(1)
    expect(utilityDetails.processMetricsCrashedProcessAbsent).toBeUndefined()
  })

  it('persists a report and flushes the process-gone trace before recovery', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails } as never,
      event(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'renderer',
        reason: 'crashed',
        exitCode: 5,
        details: expect.objectContaining({
          mainProcessPid: process.pid,
          mainProcessLaunchId: expect.any(String),
          mainProcessStartedAt: expect.any(String)
        })
      })
    )
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'electron.process_gone',
        attributes: expect.objectContaining({
          'app.main_process.pid': process.pid,
          'app.main_process.launch_id': expect.any(String),
          'app.main_process.started_at': expect.any(String)
        }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('keeps simultaneous renderer reports distinct by webContents identity', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()

    recordProcessGoneCrash(
      { record, attachDetails } as never,
      event({ webContentsId: 11 }),
      dedupe,
      noMinidump
    )
    recordProcessGoneCrash(
      { record, attachDetails } as never,
      event({ webContentsId: 22 }),
      dedupe,
      noMinidump
    )

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
  })

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

  it('keeps null persistence rejections inside the fail-open diagnostic path', async () => {
    const record = vi.fn().mockRejectedValue(null)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash(
      { record, attachDetails } as never,
      event(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'crash_report_persist_failed',
            data: expect.objectContaining({ errorName: 'object', errorMessage: 'null' })
          })
        ])
      )
    )
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

  function withStubbedPlatform(platform: NodeJS.Platform, run: () => void): void {
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    try {
      run()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    }
  }

  // Why child exits: the decode gate is source-agnostic and reads
  // process.platform synchronously at record time, so the platform stub is
  // still in force when it runs.
  const nonRecoverableChildExit = (
    overrides: Partial<ProcessGoneCrashEvent>
  ): ProcessGoneCrashEvent =>
    event({
      source: 'child',
      processType: 'Utility',
      details: { serviceName: 'node.mojom.NodeService', type: 'Utility' },
      ...overrides
    })

  it('names the decoded POSIX wait status on the span and keeps the stored code raw', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    withStubbedPlatform('linux', () => {
      recordProcessGoneCrash(
        { record } as never,
        nonRecoverableChildExit({ reason: 'abnormal-exit', exitCode: 61696 }),
        new ProcessGoneDedupe()
      )
    })

    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 61696 }))
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'electron.process_gone',
        attributes: expect.objectContaining({
          'crash.exit_code': 61696,
          'crash.exit_code_decoded': 'exit status 241'
        })
      })
    ])
  })

  it('leaves Windows exit codes and launch-failed codes undecoded', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    withStubbedPlatform('win32', () => {
      recordProcessGoneCrash(
        { record } as never,
        nonRecoverableChildExit({ reason: 'killed', exitCode: 1 }),
        new ProcessGoneDedupe()
      )
    })
    withStubbedPlatform('linux', () => {
      recordProcessGoneCrash(
        { record } as never,
        nonRecoverableChildExit({ reason: 'launch-failed', exitCode: 18 }),
        new ProcessGoneDedupe()
      )
    })

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
    expect(sink.records).toHaveLength(2)
    for (const span of sink.records) {
      expect(span).toEqual(
        expect.objectContaining({
          attributes: expect.not.objectContaining({
            'crash.exit_code_decoded': expect.anything()
          })
        })
      )
    }
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

  it('names the failing CHECK on the report that only had an exit code', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const attach = vi.fn().mockResolvedValue(null)
    const capture = vi.fn().mockResolvedValue(capturedRendererCheck)

    recordProcessGoneCrash(
      { record, attachDetails: attach } as never,
      event({ exitCode: -2147483645 }),
      new ProcessGoneDedupe(),
      capture
    )

    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce())
    expect(capture).toHaveBeenCalledWith(expect.any(Number), 'renderer')
    expect(attach).toHaveBeenCalledWith(
      'report-1',
      expect.objectContaining({
        minidumpStatus: 'captured',
        minidumpCheckMessage: capturedRendererCheck.signature.checkMessage,
        minidumpCheckFile: 'render_frame_impl.cc',
        minidumpCheckLine: 4821,
        minidumpExceptionCode: '0x80000003',
        minidumpBytes: 2_400_000
      })
    )
  })

  it('maps Electron child types to Crashpad process identities', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const attach = vi.fn().mockResolvedValue(null)
    const capture = vi.fn().mockResolvedValue(null)

    recordProcessGoneCrash(
      { record, attachDetails: attach } as never,
      event({
        source: 'child',
        processType: 'Utility',
        // A utility outside the recoverable-service allowlist still reports.
        details: { type: 'Utility', serviceName: 'storage.mojom.StorageService' }
      }),
      new ProcessGoneDedupe(),
      capture
    )

    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce())
    expect(capture).toHaveBeenCalledWith(expect.any(Number), 'utility')
  })

  it('never looks for a dump for a GPU child, which is suppressed upstream', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const capture = vi.fn().mockResolvedValue(null)

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      event({ source: 'child', processType: 'GPU', details: { type: 'GPU' } }),
      new ProcessGoneDedupe(),
      capture
    )

    // Why: GPU exits are recoverable Chromium churn (process-gone-classification.ts),
    // so they never become a report — and must not burn an 8s dump poll either.
    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'process_gone_suppressed' })])
      )
    )
    expect(record).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it('exports the signature as a span so it is countable in the bundle', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      event(),
      new ProcessGoneDedupe(),
      async () => capturedRendererCheck
    )

    await vi.waitFor(() =>
      expect(sink.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'electron.minidump_signature',
            attributes: expect.objectContaining({
              'crash.report_id': 'report-1',
              minidumpCheckFile: 'render_frame_impl.cc'
            })
          })
        ])
      )
    )
  })

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

  it('marks the report when no dump was produced, so absence is visible', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const attach = vi.fn().mockResolvedValue(null)

    recordProcessGoneCrash(
      { record, attachDetails: attach } as never,
      event(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    await vi.waitFor(() =>
      expect(attach).toHaveBeenCalledWith('report-1', { minidumpStatus: 'absent' })
    )
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
    // Why: the report did persist; releasing the claim would let the same crash
    // be recorded twice on the next process-gone event in the burst.
    expect(releaseSpy).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'crash_report_persist_failed' })])
    )
  })
})
