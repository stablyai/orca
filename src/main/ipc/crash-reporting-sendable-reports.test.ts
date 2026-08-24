import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

import { CrashReportStore } from '../crash-reporting/crash-report-store'
import { clearCrashBreadcrumbsForTest } from '../crash-reporting/crash-breadcrumb-store'
import { buildGuestRendererGoneReporter } from '../crash-reporting/guest-renderer-gone-reporter'
import { ProcessGoneDedupe } from '../crash-reporting/process-gone-dedupe'
import { recordProcessGoneCrash } from '../crash-reporting/process-gone-recorder'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import {
  getLatestPendingReport,
  getRequestedCrashReport,
  submittedReportIds
} from './crash-reporting-sendable-reports'

/** Keeps tests off the real Crashpad directory; minidump pairing has its own suite. */
const noMinidump = async () => null

let tempDir: string
let store: CrashReportStore
let dedupe: ProcessGoneDedupe

/** Mirrors the index.ts recordProcessGoneCrash glue the guest reporter is wired to. */
function recordRendererGone(
  details: { reason: string; exitCode: number | null },
  crashDetails: Record<string, unknown>,
  identity: { webContentsId: number; rendererProcessId: number | undefined }
): void {
  recordProcessGoneCrash(
    store,
    {
      source: 'renderer',
      processType: 'renderer',
      reason: details.reason,
      exitCode: details.exitCode,
      expectedTeardown: 'none',
      details: crashDetails,
      webContentsId: identity.webContentsId,
      ...(identity.rendererProcessId !== undefined
        ? { rendererProcessId: identity.rendererProcessId }
        : {})
    },
    dedupe,
    noMinidump
  )
}

function guestReporter(): ReturnType<typeof buildGuestRendererGoneReporter> {
  return buildGuestRendererGoneReporter(
    (_source, _processType, reason, exitCode, details, identity) =>
      recordRendererGone({ reason, exitCode }, details, {
        webContentsId: identity?.webContentsId ?? -1,
        rendererProcessId: identity?.rendererProcessId
      })
  )
}

/** Mirrors the main-window render-process-gone wiring in index.ts. */
function recordMainWindowRendererGone(
  details: { reason: string; exitCode: number | null },
  identity: { webContentsId: number; rendererProcessId: number | undefined }
): void {
  recordRendererGone(
    details,
    {
      processType: 'renderer',
      rendererKind: 'main-window',
      webContentsId: identity.webContentsId,
      ...(identity.rendererProcessId !== undefined
        ? { rendererProcessId: identity.rendererProcessId }
        : {})
    },
    identity
  )
}

async function waitForReportCount(count: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await store.listRecent()).toHaveLength(count)
  })
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-report-prompt-'))
  store = new CrashReportStore(path.join(tempDir, 'crash-reports.json'))
  dedupe = new ProcessGoneDedupe()
  submittedReportIds.clear()
  setActiveSink({ push: () => {}, flush: () => {}, close: () => {} })
  clearCrashBreadcrumbsForTest()
})

afterEach(async () => {
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('getLatestPendingReport renderer-kind prompt eligibility', () => {
  it('files a browser-guest renderer death without making it the startup prompt', async () => {
    guestReporter()(
      { reason: 'oom', exitCode: 5 } as Electron.RenderProcessGoneDetails,
      41,
      'browser-guest',
      7
    )
    await waitForReportCount(1)

    // The report must stay recorded for triage, carrying the kind as a typed
    // field the eligibility policy reads (not a details string)...
    const [report] = await store.listRecent()
    expect(report).toMatchObject({
      status: 'pending',
      reason: 'oom',
      rendererKind: 'browser-guest'
    })
    // ...but a web page crashing its own renderer is not an app crash.
    expect(await getLatestPendingReport(store)).toBeNull()
  })

  it('files a browser-popup renderer death without making it the startup prompt', async () => {
    guestReporter()(
      { reason: 'crashed', exitCode: 133 } as Electron.RenderProcessGoneDetails,
      205,
      'browser-popup',
      9
    )
    await waitForReportCount(1)

    expect(await store.listRecent()).toHaveLength(1)
    expect(await getLatestPendingReport(store)).toBeNull()
  })

  it('still prompts for a main-window renderer death', async () => {
    recordMainWindowRendererGone(
      { reason: 'crashed', exitCode: 5 },
      {
        webContentsId: 1,
        rendererProcessId: 3
      }
    )
    await waitForReportCount(1)

    const prompt = await getLatestPendingReport(store)
    expect(prompt).toMatchObject({ status: 'pending', reason: 'crashed', exitCode: 5 })
  })

  it('never lets a newer related guest death mask the main-window prompt', async () => {
    // Same reason/exit code inside the related-crash window, distinct renderer
    // processes: the concurrent-death shape that files two reports (#15052).
    recordMainWindowRendererGone(
      { reason: 'oom', exitCode: 5 },
      {
        webContentsId: 1,
        rendererProcessId: 3
      }
    )
    await waitForReportCount(1)
    guestReporter()(
      { reason: 'oom', exitCode: 5 } as Electron.RenderProcessGoneDetails,
      41,
      'browser-guest',
      7
    )
    await waitForReportCount(2)

    const prompt = await getLatestPendingReport(store)
    expect(prompt?.rendererKind).toBe('main-window')
  })

  it('keeps prompting for reports that carry no renderer kind', async () => {
    // Child-process and pre-existing on-disk reports have no renderer kind.
    await store.record({
      source: 'child',
      processType: 'gpu',
      reason: 'crashed',
      exitCode: 11,
      appVersion: '1.2.3-test',
      platform: process.platform,
      osRelease: 'test',
      arch: process.arch,
      electronVersion: '43',
      chromeVersion: '143',
      details: {}
    })

    const prompt = await getLatestPendingReport(store)
    expect(prompt).toMatchObject({ processType: 'gpu', exitCode: 11 })
  })

  it('keeps a prompt-suppressed guest report reachable for Help menu diagnostics', async () => {
    guestReporter()(
      { reason: 'oom', exitCode: 5 } as Electron.RenderProcessGoneDetails,
      41,
      'browser-guest',
      7
    )
    await waitForReportCount(1)

    // Suppression is about the startup prompt only, never triage visibility.
    const report = await getRequestedCrashReport(store)
    expect(report).toMatchObject({ status: 'pending', reason: 'oom' })
  })
})
