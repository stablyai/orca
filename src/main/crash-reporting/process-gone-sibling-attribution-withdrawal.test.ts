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
  correlateChildProcessDeath,
  trackRendererSiblingAttribution
} from './process-gone-sibling-attribution'
import {
  collectLateSiblingAttributions,
  resetProcessGoneSiblingCorrelationForTest,
  trackRendererCrashReport,
  type ChildProcessDeath
} from './process-gone-sibling-correlation'
import { _resetTracerForTests } from '../observability/tracer'
import type { CrashReportCreateInput } from '../../shared/crash-reporting'

// Field shape: crash report 11a9d459 (v1.4.199, win32 10.0.19045), renderer
// crashed/-2147483645 (0x80000003) with a GPU process crash-looping at -17ms / +14ms / +61ms.
const BREAKPOINT_EXIT = -2_147_483_645
const GONE_AT = 1_789_021_889_062
const CONCURRENT = 'concurrent-process-deaths'

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

function gpuDeath(at: number): ChildProcessDeath {
  return {
    at,
    processType: 'GPU',
    serviceName: 'GPU',
    reason: 'crashed',
    exitCode: BREAKPOINT_EXIT
  }
}

function rendererReportInput(details: Record<string, unknown>): CrashReportCreateInput {
  return {
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
    details
  }
}

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

/** The amend is fire-and-forget behind two real file writes, so poll the stored document. */
async function rendererDetails(expectedSiblingCount: number): Promise<Record<string, unknown>> {
  return vi.waitFor(async () => {
    // By source, not position: a recorded child report would otherwise head the list and
    // make this poll time out instead of fail.
    const report = (await store.listRecent()).find((candidate) => candidate.source === 'renderer')
    expect(report?.details.siblingProcessDeathCount).toBe(expectedSiblingCount)
    return report!.details
  })
}

describe('sibling attribution withdrawal', () => {
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

    const details = await rendererDetails(3)
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

    const details = await rendererDetails(2)
    expect(details.siblingProcessDeathRepeats).toBeUndefined()
    expect(details.crashAttribution).toBe(CONCURRENT)
  })

  it('withdraws only the disproved key and leaves the rest of the report intact', async () => {
    const recorded = await store.record(
      rendererReportInput({ crashAttribution: CONCURRENT, minidumpStatus: 'captured' })
    )

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
 * The amend is fire-and-forget: `siblingAttributionAttacher` logs a failed write and moves
 * on. A withdrawal that never reached the file has to stay owed, or the Windows retry ladder
 * exhausting once (EPERM/EBUSY) ships the stale label the amend existed to take back.
 */
describe('a withdrawal amend whose write never lands', () => {
  it('re-emits it on the next late sibling until the report loses the label', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recorded = await store.record(
      rendererReportInput({ crashAttribution: CONCURRENT, siblingProcessDeathCount: 1 })
    )
    const attachDetails = vi
      .fn<(reportId: string, details: Record<string, unknown>) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockImplementation((reportId, details) => store.attachDetails(reportId, details))

    trackRendererSiblingAttribution(
      { source: 'renderer', reason: 'crashed', exitCode: BREAKPOINT_EXIT },
      GONE_AT,
      [gpuDeath(GONE_AT - 17)],
      attachDetails,
      Promise.resolve(recorded),
      { source: 'renderer', processType: 'renderer', reason: 'crashed', exitCode: BREAKPOINT_EXIT }
    )

    correlateChildProcessDeath(gpuDeath(GONE_AT + 14))
    correlateChildProcessDeath(gpuDeath(GONE_AT + 61))

    await vi.waitFor(async () => {
      const [persisted] = await store.listRecent()
      expect(persisted.details).not.toHaveProperty('crashAttribution')
    })
    // Both amends carry it: the first was dropped, so the second still owes the withdrawal.
    expect(attachDetails.mock.calls.map(([, details]) => details.crashAttribution)).toEqual([
      null,
      null
    ])
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
