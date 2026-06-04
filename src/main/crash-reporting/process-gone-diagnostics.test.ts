import { describe, expect, it, vi } from 'vitest'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData,
  collectProcessGoneMetricDetails
} from './process-gone-diagnostics'

type MetricFixture = {
  pid: number
  type: string
  memory: { workingSetSize: number }
}

const { appMetricsMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn<() => MetricFixture[]>(() => [])
}))

vi.mock('electron', () => ({
  app: {
    getAppMetrics: appMetricsMock
  }
}))

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
})
