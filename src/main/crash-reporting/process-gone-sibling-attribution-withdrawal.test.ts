import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.4.199-test',
    getAppMetrics: () => [],
    getPath: () => os.tmpdir()
  }
}))

import { CrashReportStore } from './crash-report-store'
import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import {
  collectLateSiblingAttributions,
  resetProcessGoneSiblingCorrelationForTest,
  trackRendererCrashReport,
  type ChildProcessDeath
} from './process-gone-sibling-correlation'
import { _resetTracerForTests } from '../observability/tracer'

// Field shape: crash report 11a9d459 (v1.4.199, win32 10.0.19045), renderer
// crashed/-2147483645 (0x80000003) with a GPU process crash-looping at -17ms / +14ms / +61ms.
const BREAKPOINT_EXIT = -2_147_483_645
const GONE_AT = 1_789_021_889_062

const noMinidump = async () => null
const originalPlatform = process.platform

function gpuChildCrash(): ProcessGoneCrashEvent {
  return {
    source: 'child',
    processType: 'GPU',
    reason: 'crashed',
    exitCode: BREAKPOINT_EXIT,
    expectedTeardown: 'none',
    details: { serviceName: 'GPU', type: 'GPU' }
  }
}

function networkServiceCrash(): ProcessGoneCrashEvent {
  return {
    source: 'child',
    processType: 'Utility',
    reason: 'crashed',
    exitCode: BREAKPOINT_EXIT,
    expectedTeardown: 'none',
    details: { serviceName: 'network.mojom.NetworkService', type: 'Utility' }
  }
}

function rendererCrash(): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: BREAKPOINT_EXIT,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    webContentsId: 1
  }
}

/** The amend is fire-and-forget behind two real file writes, so poll the stored document. */
async function rendererDetails(
  store: CrashReportStore,
  expectedSiblingCount: number
): Promise<Record<string, unknown>> {
  return vi.waitFor(async () => {
    const [report] = await store.listRecent()
    expect(report?.details.siblingProcessDeathCount).toBe(expectedSiblingCount)
    return report.details
  })
}

describe('sibling attribution withdrawal', () => {
  let directory: string
  let store: CrashReportStore

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-sibling-attr-'))
    store = new CrashReportStore(path.join(directory, 'crash-reports.json'))
    resetProcessGoneSiblingCorrelationForTest()
    clearCrashBreadcrumbsForTest()
    _resetTracerForTests()
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.restoreAllMocks()
    resetProcessGoneSiblingCorrelationForTest()
    clearCrashBreadcrumbsForTest()
    _resetTracerForTests()
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('drops crashAttribution once a repeating sibling identity disqualifies it', async () => {
    const dedupe = new ProcessGoneDedupe()
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(GONE_AT - 17)
    recordProcessGoneCrash(store, gpuChildCrash(), dedupe, noMinidump)

    now.mockReturnValue(GONE_AT)
    recordProcessGoneCrash(store, rendererCrash(), dedupe, noMinidump)

    // Same GPU identity dies twice more: a crash-looping child, which
    // isOneIncident() explicitly refuses to call concurrent-process-deaths.
    now.mockReturnValue(GONE_AT + 14)
    recordProcessGoneCrash(store, gpuChildCrash(), dedupe, noMinidump)
    now.mockReturnValue(GONE_AT + 61)
    recordProcessGoneCrash(store, gpuChildCrash(), dedupe, noMinidump)

    const details = await rendererDetails(store, 3)
    expect(details.siblingProcessDeathRepeats).toBe(2)
    expect(details.siblingProcessDeaths).toBe('GPU +14ms, GPU -17ms, GPU +61ms')
    expect(details).not.toHaveProperty('crashAttribution')
  })

  it('keeps the label when a second distinct sibling leaves the incident intact', async () => {
    const dedupe = new ProcessGoneDedupe()
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(GONE_AT - 17)
    recordProcessGoneCrash(store, gpuChildCrash(), dedupe, noMinidump)
    now.mockReturnValue(GONE_AT)
    recordProcessGoneCrash(store, rendererCrash(), dedupe, noMinidump)
    now.mockReturnValue(GONE_AT + 14)
    recordProcessGoneCrash(store, networkServiceCrash(), dedupe, noMinidump)

    const details = await rendererDetails(store, 2)
    expect(details.siblingProcessDeathRepeats).toBeUndefined()
    expect(details.crashAttribution).toBe('concurrent-process-deaths')
  })

  it('withdraws only the disproved key and leaves the rest of the report intact', async () => {
    const recorded = await store.record({
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: BREAKPOINT_EXIT,
      appVersion: '1.4.199-test',
      platform: 'win32',
      osRelease: '10.0.19045',
      arch: 'x64',
      electronVersion: '38.0.0',
      chromeVersion: '140.0.0.0',
      details: { crashAttribution: 'concurrent-process-deaths', minidumpStatus: 'captured' }
    })

    const amended = await store.attachDetails(recorded.id, {
      crashAttribution: null,
      siblingProcessDeathRepeats: 2
    })

    expect(amended?.details).toEqual({
      minidumpStatus: 'captured',
      siblingProcessDeathRepeats: 2
    })
    // Withdrawal must survive the round trip, not just the in-memory result.
    const [persisted] = await store.listRecent()
    expect(persisted.details).not.toHaveProperty('crashAttribution')
  })
})

/**
 * The amend is fire-and-forget: `attachAttribution` logs a failed write and moves on. A
 * withdrawal that never reached the file has to stay owed, or the Windows retry ladder
 * exhausting once (EPERM/EBUSY) ships the stale label the amend existed to take back.
 */
describe('a withdrawal amend whose write never lands', () => {
  const gpuDeath = (at: number): ChildProcessDeath => ({
    at,
    processType: 'GPU',
    serviceName: 'GPU',
    reason: 'crashed',
    exitCode: BREAKPOINT_EXIT
  })

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resetProcessGoneSiblingCorrelationForTest()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    resetProcessGoneSiblingCorrelationForTest()
  })

  it('re-emits it on the next late sibling instead of reporting it withdrawn', () => {
    trackRendererCrashReport(
      {
        at: GONE_AT,
        reason: 'crashed',
        exitCode: BREAKPOINT_EXIT,
        attachAttribution: () => {
          throw new Error('the amend is fire-and-forget; this write is dropped')
        }
      },
      [gpuDeath(GONE_AT - 17)]
    )

    const [dropped] = collectLateSiblingAttributions(gpuDeath(GONE_AT + 14))
    expect(dropped.attribution.crashAttribution).toBeNull()
    const [retried] = collectLateSiblingAttributions(gpuDeath(GONE_AT + 61))
    expect(retried.attribution.crashAttribution).toBeNull()
  })

  it('never withdraws a label the report was never given', () => {
    trackRendererCrashReport(
      {
        at: GONE_AT,
        reason: 'crashed',
        exitCode: BREAKPOINT_EXIT,
        attachAttribution: () => {}
      },
      // -900ms is in-window but too loose to attribute, so nothing was ever written.
      [gpuDeath(GONE_AT - 900)]
    )

    const [attribution] = collectLateSiblingAttributions(gpuDeath(GONE_AT + 14))
    expect(attribution.attribution).not.toHaveProperty('crashAttribution')
  })
})
