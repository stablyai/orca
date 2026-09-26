import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportCreateInput, CrashReportRecord } from '../../shared/crash-reporting'

const { appMetricsMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn((): unknown[] => [
    { pid: 10, type: 'Browser', memory: { workingSetSize: 1024 * 100 } }
  ])
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.4.200-test', getAppMetrics: appMetricsMock }
}))

import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import { setPreviousLaunchExitForTest } from './previous-launch-exit-verdict'

const noMinidump = async () => null
const silentSink: TracerSink = { push: vi.fn(), flush: vi.fn(), close: vi.fn() }

// The v1.4.200 field shape: Windows renderer, reason=killed, exit code 1.
const killedRendererEvent: ProcessGoneCrashEvent = {
  source: 'renderer',
  processType: 'renderer',
  reason: 'killed',
  exitCode: 1,
  expectedTeardown: 'none',
  details: { processType: 'renderer' }
}

async function recordedDetails(): Promise<Record<string, unknown>> {
  const record = vi.fn(async (input: CrashReportCreateInput): Promise<CrashReportRecord> => ({
    ...input,
    id: 'report-1',
    createdAt: '2026-09-12T00:00:00.000Z',
    status: 'pending',
    details: {},
    breadcrumbs: undefined
  }))
  recordProcessGoneCrash(
    { record, attachDetails: async () => null },
    killedRendererEvent,
    new ProcessGoneDedupe(),
    noMinidump
  )
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
  return record.mock.calls[0][0].details
}

beforeEach(() => {
  setActiveSink(silentSink)
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
  setPreviousLaunchExitForTest(null)
})

afterEach(() => {
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
  setPreviousLaunchExitForTest(null)
  vi.restoreAllMocks()
})

describe('abrupt whole-app death legibility on process-gone reports', () => {
  it('dates the surviving-browser census against the death it was taken for', async () => {
    const details = await recordedDetails()

    expect(details.processMetricsBrowserCount).toBe(1)
    expect(details.processMetricsSampleAfterGoneMs).toBeTypeOf('number')
    expect(details.processMetricsSampleAfterGoneMs).toBeLessThan(1_000)
  })

  it('names the previous launch that died abruptly', async () => {
    setPreviousLaunchExitForTest({ previousLaunchId: 'launch-a', diedAbruptly: true })

    await expect(recordedDetails()).resolves.toMatchObject({
      previousMainProcessLaunchId: 'launch-a',
      previousMainProcessDiedAbruptly: true
    })
  })

  it('publishes no previous-launch claim without a verdict', async () => {
    const details = await recordedDetails()

    expect(details.previousMainProcessLaunchId).toBeUndefined()
    expect(details.previousMainProcessDiedAbruptly).toBeUndefined()
  })
})
