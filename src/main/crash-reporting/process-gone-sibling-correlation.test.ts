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
const CONCURRENT = 'concurrent-process-deaths'

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

const networkServiceCrash = event({
  source: 'child',
  processType: 'Utility',
  details: {
    name: 'Network Service',
    serviceName: 'network.mojom.NetworkService',
    type: 'Utility'
  }
})
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

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function record(store: ReturnType<typeof recorderStore>, crash: ProcessGoneCrashEvent): void {
  recordProcessGoneCrash(store as never, crash, new ProcessGoneDedupe(), noMinidump)
}

function recordedDetails(store: ReturnType<typeof recorderStore>): Record<string, unknown> {
  return store.record.mock.calls[0]?.[0].details as Record<string, unknown>
}

function siblingAttaches(store: ReturnType<typeof recorderStore>): Record<string, unknown>[] {
  return store.attachDetails.mock.calls
    .map((call) => call[1] as Record<string, unknown>)
    .filter((details) => 'siblingProcessDeathCount' in details)
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
  // Report a326935a (bundle F0BQMB30GJX, win32 10.0.22631, 1.4.184): the network
  // service died crashed/-1 21ms before the renderer died the same way, and only
  // the renderer half reached the crash channel.
  it('attributes a renderer crash to a network service that died 21ms earlier', async () => {
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt - 21)
    record(store, networkServiceCrash)
    at(rendererAt)
    record(store, event())

    // The child half is suppressed as recoverable churn, so only the renderer is
    // reported — and the correlation still saw the suppressed event.
    expect(store.record).toHaveBeenCalledOnce()
    expect(recordedDetails(store)).toMatchObject({
      crashAttribution: CONCURRENT,
      siblingProcessDeathCount: 1,
      siblingProcessDeaths: 'Utility/network.mojom.NetworkService -21ms'
    })
    await vi.waitFor(() => expect(store.attachDetails).toHaveBeenCalled())
  })

  // Report 1862f316 (bundle F0BRPP8TC0Y, win32 10.0.26100, 1.4.184): audio service
  // -2ms, renderer, then GPU +180ms. The GPU half lands after the renderer report
  // is already on disk, so it has to be folded into the persisted record.
  it('folds a GPU death 180ms after the renderer into the persisted report', async () => {
    const store = recorderStore()
    const rendererAt = 1_787_017_254_450

    at(rendererAt - 2)
    record(store, audioServiceCrash)
    at(rendererAt)
    record(store, event())
    at(rendererAt + 180)
    record(store, gpuCrash)

    expect(store.record).toHaveBeenCalledOnce()
    expect(recordedDetails(store)).toMatchObject({
      siblingProcessDeathCount: 1,
      siblingProcessDeaths: 'Utility/audio.mojom.AudioService -2ms'
    })
    await vi.waitFor(() =>
      expect(store.attachDetails).toHaveBeenCalledWith(
        'report-1',
        expect.objectContaining({
          crashAttribution: CONCURRENT,
          siblingProcessDeathCount: 2,
          siblingProcessDeaths: 'Utility/audio.mojom.AudioService -2ms, GPU +180ms'
        })
      )
    )
    expect(getCrashBreadcrumbSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'process_gone_sibling_attribution' })
      ])
    )
  })

  it('still reports a lone renderer crash with no attribution', async () => {
    const store = recorderStore()

    at(1_786_995_438_107)
    record(store, event())

    expect(store.record).toHaveBeenCalledOnce()
    expect(recordedDetails(store)).not.toHaveProperty('crashAttribution')
    await vi.waitFor(() => expect(store.attachDetails).toHaveBeenCalled())
    expect(siblingAttaches(store)).toEqual([])
  })

  // A child dying long after the renderer is at least as likely to be an effect of
  // the renderer death as a cause of it, so the lookahead stops at the observed
  // collateral spread instead of mirroring the 1s lookback.
  it('never retro-labels a persisted crash from a child that died 900ms later', async () => {
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt)
    record(store, event())
    at(rendererAt + 900)
    record(store, networkServiceCrash)

    expect(recordedDetails(store)).not.toHaveProperty('crashAttribution')
    await vi.waitFor(() => expect(store.attachDetails).toHaveBeenCalled())
    expect(siblingAttaches(store)).toEqual([])
  })

  // Ordinary recoverable churn lands inside the lookback on any host running a
  // looping child; it is evidence, never a verdict.
  it('keeps a loose in-window child death as evidence without attributing to it', () => {
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt - 900)
    record(store, networkServiceCrash)
    at(rendererAt)
    record(store, event())

    expect(recordedDetails(store)).toMatchObject({
      siblingProcessDeathCount: 1,
      siblingProcessDeaths: 'Utility/network.mojom.NetworkService -900ms'
    })
    expect(recordedDetails(store)).not.toHaveProperty('crashAttribution')
  })

  it('stops rewriting the report once a child starts looping', async () => {
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt)
    record(store, event())
    for (let index = 1; index <= 20; index += 1) {
      at(rendererAt + index)
      record(store, networkServiceCrash)
    }

    // A network service looping at the observed 1459/min cannot keep rewriting the
    // record, and a repeated identity is a loop rather than one incident.
    await vi.waitFor(() => expect(siblingAttaches(store)).toHaveLength(2))
    expect(siblingAttaches(store)[0]).toMatchObject({ crashAttribution: CONCURRENT })
    expect(siblingAttaches(store)[1]).toMatchObject({ siblingProcessDeathRepeats: 1 })
    expect(siblingAttaches(store)[1]).not.toHaveProperty('crashAttribution')
  })

  it('does not erase recorded sibling evidence during unrelated child churn', async () => {
    const store = recorderStore()
    const churnStore = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt - 21)
    record(store, networkServiceCrash)
    at(rendererAt)
    record(store, event())
    for (let index = 1; index <= 16; index += 1) {
      at(rendererAt + index)
      record(churnStore, event({ ...gpuCrash, reason: 'killed' }))
    }
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(recordedDetails(store)).toMatchObject({
      crashAttribution: CONCURRENT,
      siblingProcessDeathCount: 1
    })
    expect(siblingAttaches(store)).toEqual([])
  })

  it('bounds pending reports during a multi-renderer crash storm', async () => {
    const stores = Array.from({ length: 32 }, recorderStore)
    const childStore = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt)
    stores.forEach((store, index) => {
      record(store, event({ webContentsId: index + 1 }))
    })
    at(rendererAt + 100)
    record(childStore, gpuCrash)

    await vi.waitFor(() =>
      expect(stores.flatMap((store) => siblingAttaches(store))).toHaveLength(16)
    )
    expect(stores.slice(0, 16).flatMap((store) => siblingAttaches(store))).toEqual([])
    expect(stores.slice(16).flatMap((store) => siblingAttaches(store))).toHaveLength(16)
  })

  it('drops whole entries rather than letting the detail cap cut one mid-token', () => {
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107
    const churn = [networkServiceCrash, audioServiceCrash, gpuCrash]

    for (let index = 12; index >= 1; index -= 1) {
      at(rendererAt - index)
      record(store, churn[index % churn.length] as ProcessGoneCrashEvent)
    }
    at(rendererAt)
    record(store, event())

    const deaths = String(recordedDetails(store).siblingProcessDeaths)
    expect(recordedDetails(store).siblingProcessDeathCount).toBe(12)
    expect(deaths).toMatch(/ \(\+\d+ more\)$/)
    // Short of the 240-char generic detail cap, so nothing is cut mid-token.
    expect(deaths.length).toBeLessThan(240)
  })

  it('ignores a child death whose reason names a different failure', async () => {
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt - 21)
    record(store, event({ ...networkServiceCrash, reason: 'killed' }))
    at(rendererAt)
    record(store, event())
    at(rendererAt + 10)
    record(store, event({ ...gpuCrash, reason: 'killed' }))

    expect(recordedDetails(store)).not.toHaveProperty('crashAttribution')
    expect(recordedDetails(store)).not.toHaveProperty('siblingProcessDeathCount')
    // An in-window death that matches nothing must not rewrite the record with an
    // empty sibling set either.
    await vi.waitFor(() => expect(store.attachDetails).toHaveBeenCalled())
    expect(siblingAttaches(store)).toEqual([])
  })

  it('ignores a win32 child death with a different exit code', () => {
    onPlatform('win32')
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt - 21)
    record(store, event({ ...networkServiceCrash, exitCode: -1_073_741_819 }))
    at(rendererAt)
    record(store, event())

    expect(recordedDetails(store)).not.toHaveProperty('crashAttribution')
  })

  // POSIX reports a per-process wait status, so a collateral pair carries two
  // different codes (utility SIGKILL 9, renderer SIGSEGV 11) for one incident.
  it('correlates a POSIX pair whose per-process wait statuses differ', () => {
    onPlatform('darwin')
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt - 21)
    record(store, event({ ...networkServiceCrash, reason: 'abnormal-exit', exitCode: 9 }))
    at(rendererAt)
    record(store, event({ exitCode: 11 }))

    expect(recordedDetails(store)).toMatchObject({
      crashAttribution: CONCURRENT,
      siblingProcessDeathCount: 1
    })
  })

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

  it('ignores a child death outside the correlation window', async () => {
    const store = recorderStore()
    const rendererAt = 1_786_995_438_107

    at(rendererAt - 1_200)
    record(store, networkServiceCrash)
    at(rendererAt)
    record(store, event())
    at(rendererAt + 1_200)
    record(store, gpuCrash)

    expect(recordedDetails(store)).not.toHaveProperty('crashAttribution')
    await vi.waitFor(() => expect(store.attachDetails).toHaveBeenCalled())
    expect(siblingAttaches(store)).toEqual([])
  })
})
