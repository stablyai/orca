import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: () => []
  }
}))

import { clearCrashBreadcrumbsForTest, getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import { _resetTracerForTests } from '../observability/tracer'

const noMinidump = async () => null

function recorderStore() {
  return {
    record: vi.fn().mockResolvedValue({ id: 'report-1' }),
    attachDetails: vi.fn().mockResolvedValue(null)
  }
}

function event(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: -1,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    ...overrides
  }
}
const audioServiceCrash = event({
  source: 'child',
  processType: 'Utility',
  details: { name: 'Audio Service', serviceName: 'audio.mojom.AudioService', type: 'Utility' }
})
const gpuCrash = event({
  source: 'child',
  processType: 'GPU',
  details: { serviceName: 'GPU', type: 'GPU' }
})

function at(timeMs: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(timeMs)
}

const originalPlatform = process.platform

function record(store: ReturnType<typeof recorderStore>, crash: ProcessGoneCrashEvent): void {
  recordProcessGoneCrash(store as never, crash, new ProcessGoneDedupe(), noMinidump)
}

beforeEach(() => {
  resetProcessGoneSiblingCorrelationForTest()
  clearCrashBreadcrumbsForTest()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

describe('sibling process-death attribution', () => {
  it('scopes a late-amend failure to the reporting renderer', async () => {
    const store = recorderStore()
    store.attachDetails.mockRejectedValue(new Error('EPERM'))
    const rendererAt = 1_787_017_254_450

    at(rendererAt - 2)
    record(store, audioServiceCrash)
    at(rendererAt)
    record(store, event({ webContentsId: 11 }))
    at(rendererAt + 180)
    record(store, gpuCrash)

    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot('renderer:11')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'sibling_attribution_attach_failed' })
        ])
      )
    )
    expect(getCrashBreadcrumbSnapshot('renderer:22')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'sibling_attribution_attach_failed' })
      ])
    )
  })
})
