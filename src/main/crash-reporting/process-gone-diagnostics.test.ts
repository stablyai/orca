import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildProcessGoneCrashDetails,
  buildProcessGoneNoCaptureDiagnosticAttributes,
  buildSuppressedProcessGoneBreadcrumbData,
  collectProcessGoneMetricDetails,
  recordProcessGoneNoCaptureDiagnostic
} from './process-gone-diagnostics'

type MetricFixture = {
  pid: number
  type: string
  memory: { workingSetSize: number }
}

const { appMetricsMock, startSpanMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn<() => MetricFixture[]>(() => []),
  startSpanMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getAppMetrics: appMetricsMock
  }
}))

vi.mock('../observability/tracer', () => ({
  startSpan: startSpanMock
}))

afterEach(() => {
  appMetricsMock.mockClear()
  startSpanMock.mockReset()
  vi.restoreAllMocks()
})

describe('process gone diagnostics', () => {
  it('summarizes Electron process memory by crash-report-friendly buckets', () => {
    const details = collectProcessGoneMetricDetails([
      { pid: 10, type: 'Browser', memory: { workingSetSize: 1024 * 200 } },
      { pid: 11, type: 'Tab', memory: { workingSetSize: 1024 * 750 } },
      { pid: 12, type: 'Renderer', memory: { workingSetSize: 1024 * 125 } },
      { pid: 13, type: 'GPU', memory: { workingSetSize: 1024 * 320 } },
      { pid: 14, type: 'Utility', memory: { workingSetSize: 1024 * 90 } },
      { pid: 15, type: 'Service', memory: { workingSetSize: 1024 * 15 } }
    ])

    expect(details).toEqual({
      processMetricsCount: 6,
      processMetricsBrowserCount: 1,
      processMetricsBrowserWorkingSetMB: 200,
      processMetricsRendererCount: 2,
      processMetricsRendererWorkingSetMB: 875,
      processMetricsGpuCount: 1,
      processMetricsGpuWorkingSetMB: 320,
      processMetricsUtilityCount: 1,
      processMetricsUtilityWorkingSetMB: 90,
      processMetricsOtherCount: 1,
      processMetricsOtherWorkingSetMB: 15,
      processMetricsLargestPid: 11,
      processMetricsLargestType: 'Tab',
      processMetricsLargestWorkingSetMB: 750
    })
  })

  it('adds process metrics to persisted crash details', () => {
    appMetricsMock.mockReturnValue([
      { pid: 21, type: 'Browser', memory: { workingSetSize: 1024 * 100 } },
      { pid: 22, type: 'Tab', memory: { workingSetSize: 1024 * 400 } }
    ])

    expect(buildProcessGoneCrashDetails({ processType: 'renderer' })).toMatchObject({
      processType: 'renderer',
      processMetricsCount: 2,
      processMetricsRendererWorkingSetMB: 400,
      processMetricsLargestPid: 22
    })
  })

  it('preserves child process identity on suppressed breadcrumbs', () => {
    expect(
      buildSuppressedProcessGoneBreadcrumbData({
        source: 'child',
        processType: 'Utility',
        reason: 'killed',
        exitCode: 1,
        details: {
          name: 'Network Service',
          serviceName: 'network.mojom.NetworkService',
          nested: { ignored: true }
        }
      })
    ).toEqual({
      source: 'child',
      processType: 'Utility',
      reason: 'killed',
      exitCode: 1,
      name: 'Network Service',
      serviceName: 'network.mojom.NetworkService'
    })
  })

  it('records durable suppressed-process diagnostics with sanitized identity fields', () => {
    const end = vi.fn()
    startSpanMock.mockReturnValue({ end })

    const attributes = buildProcessGoneNoCaptureDiagnosticAttributes({
      source: 'renderer',
      processType: 'renderer',
      reason: 'killed',
      exitCode: 0,
      details: {
        name: 'C:\\Users\\alice\\Renderer',
        serviceName: 'renderer.service token=abc123',
        type: 'tab',
        nested: { ignored: true }
      }
    })

    expect(attributes).toEqual({
      kind: 'crash-no-capture',
      source: 'renderer',
      processType: 'renderer',
      reason: 'killed',
      exitCode: 0,
      name: '[redacted-path]',
      serviceName: 'renderer.service token=[redacted]',
      type: 'tab'
    })

    recordProcessGoneNoCaptureDiagnostic('process_gone_suppressed', {
      source: 'renderer',
      processType: 'renderer',
      reason: 'killed',
      exitCode: 0,
      details: {
        name: 'C:\\Users\\alice\\Renderer',
        serviceName: 'renderer.service token=abc123',
        type: 'tab'
      }
    })

    expect(startSpanMock).toHaveBeenCalledWith('process_gone_suppressed', {
      attributes
    })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('records a store-unavailable no-capture span with process-gone identity fields', () => {
    const end = vi.fn()
    startSpanMock.mockReturnValue({ end })

    recordProcessGoneNoCaptureDiagnostic('process_gone_store_unavailable', {
      source: 'child',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: null,
      details: {
        name: 'Renderer',
        serviceName: 'renderer.service'
      }
    })

    expect(startSpanMock).toHaveBeenCalledWith('process_gone_store_unavailable', {
      attributes: {
        kind: 'crash-no-capture',
        source: 'child',
        processType: 'renderer',
        reason: 'crashed',
        name: 'Renderer',
        serviceName: 'renderer.service'
      }
    })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('sanitizes persist-failed error payloads before recording the span', () => {
    const end = vi.fn()
    startSpanMock.mockReturnValue({ end })

    const attributes = buildProcessGoneNoCaptureDiagnosticAttributes({
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: 5,
      details: {
        name: 'Renderer',
        serviceName: 'renderer.service'
      },
      error: new Error(
        'failed at C:\\Users\\alice\\workspace with token=abc123 and sk-12345678901234567890'
      )
    })

    expect(attributes).toMatchObject({
      kind: 'crash-no-capture',
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: 5,
      name: 'Renderer',
      serviceName: 'renderer.service',
      'error.name': 'Error'
    })
    expect(attributes['error.message']).toContain('[redacted-path]')
    expect(attributes['error.message']).toContain('token=[redacted]')
    expect(attributes['error.message']).toContain('[redacted-secret]')

    recordProcessGoneNoCaptureDiagnostic('process_gone_persist_failed', {
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: 5,
      details: {
        name: 'Renderer',
        serviceName: 'renderer.service'
      },
      error: new Error(
        'failed at C:\\Users\\alice\\workspace with token=abc123 and sk-12345678901234567890'
      )
    })

    expect(startSpanMock).toHaveBeenCalledWith('process_gone_persist_failed', {
      attributes
    })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('preserves falsey persistence rejection details', () => {
    expect(
      buildProcessGoneNoCaptureDiagnosticAttributes({
        source: 'renderer',
        processType: 'renderer',
        reason: 'crashed',
        exitCode: 5,
        details: {},
        error: 0
      })
    ).toMatchObject({
      'error.name': 'number',
      'error.message': '0'
    })
  })

  it('swallows tracer failures when recording no-capture diagnostics', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startSpanMock.mockImplementation(() => {
      throw new Error('boom')
    })

    expect(() =>
      recordProcessGoneNoCaptureDiagnostic('process_gone_store_unavailable', {
        source: 'child',
        processType: 'renderer',
        reason: 'crashed',
        exitCode: null,
        details: {}
      })
    ).not.toThrow()

    expect(warn).toHaveBeenCalledWith(
      '[crash-reporting] Failed to record no-capture crash diagnostic:',
      expect.any(Error)
    )
  })
})
