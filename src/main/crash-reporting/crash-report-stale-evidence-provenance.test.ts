import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appMetricsMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn((): unknown[] => [])
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.4.197-test',
    getAppMetrics: appMetricsMock
  }
}))

import type { CrashReportCreateInput, CrashReportRecord } from '../../shared/crash-reporting'
import type { CrashReportStore } from './crash-report-store'
import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import {
  noteHostProcessSpawnFailure,
  resetHostProcessSpawnRefusalForTest
} from './host-process-spawn-refusal'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { resetPreGoneCrashSamplingForTest } from './process-gone-diagnostics'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import {
  recordSelfInitiatedTreeKill,
  resetSelfInitiatedTreeKillLogForTest
} from './self-initiated-tree-kill-log'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

// ─── Report a8b4e777, reconstructed ─────────────────────────────────
// Two investigators read the same report and reached opposite verdicts: its
// newest breadcrumb was a `self_tree_kill` that sat flush against the renderer
// death, and nothing in the report said the crumb was 17 minutes old.
const TASKKILL_AT = Date.parse('2025-08-14T16:38:37.483Z')
const RENDERER_GONE_AT = TASKKILL_AT + 1_046_666

const noMinidump = async () => null

function sink(): TracerSink {
  return { push: vi.fn(), flush: vi.fn(), close: vi.fn() }
}

function rendererKilled(): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode: 1,
    expectedTeardown: 'none',
    details: { processType: 'renderer' }
  }
}

// Only `id` is read back; the report under test is the argument, not the result.
const PERSISTED: CrashReportRecord = {
  id: 'report-1',
  createdAt: new Date(0).toISOString(),
  status: 'pending',
  source: 'renderer',
  processType: 'renderer',
  reason: 'killed',
  exitCode: 1,
  appVersion: '1.4.197-test',
  platform: process.platform,
  osRelease: 'test',
  arch: process.arch,
  electronVersion: 'test',
  chromeVersion: 'test',
  details: {}
}

function storeFake(
  record: CrashReportStore['record']
): Pick<CrashReportStore, 'record' | 'attachDetails'> {
  return { record, attachDetails: async () => null }
}

async function recordedReport(): Promise<CrashReportCreateInput> {
  const record = vi.fn(async (_input: CrashReportCreateInput) => PERSISTED)
  recordProcessGoneCrash(storeFake(record), rendererKilled(), new ProcessGoneDedupe(), noMinidump)
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
  return record.mock.calls[0]![0]
}

beforeEach(() => {
  vi.useFakeTimers()
  setActiveSink(sink())
  clearCrashBreadcrumbsForTest()
  resetSelfInitiatedTreeKillLogForTest()
  resetProcessGoneSiblingCorrelationForTest()
  resetPreGoneCrashSamplingForTest()
  resetHostProcessSpawnRefusalForTest()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetSelfInitiatedTreeKillLogForTest()
  resetProcessGoneSiblingCorrelationForTest()
  resetPreGoneCrashSamplingForTest()
  resetHostProcessSpawnRefusalForTest()
})

describe('a stale breadcrumb ring cannot be read as the cause of death', () => {
  it('stamps the age of the newest breadcrumb onto the report', async () => {
    vi.setSystemTime(TASKKILL_AT)
    recordSelfInitiatedTreeKill({
      pid: 5732,
      site: 'git-command-tree-kill',
      scope: 'win-taskkill-tree',
      at: TASKKILL_AT
    })
    vi.setSystemTime(RENDERER_GONE_AT)

    const report = await recordedReport()

    expect(report.details).toMatchObject({
      breadcrumbCount: 1,
      breadcrumbNewestAgeMs: 1_046_666,
      breadcrumbNewestName: 'self_tree_kill',
      breadcrumbsInCausalWindowCount: 0
    })
  })

  it('labels the crumbs that are too old to have caused the death', async () => {
    vi.setSystemTime(TASKKILL_AT)
    recordSelfInitiatedTreeKill({
      pid: 5732,
      site: 'git-command-tree-kill',
      scope: 'win-taskkill-tree',
      at: TASKKILL_AT
    })
    vi.setSystemTime(RENDERER_GONE_AT)

    const report = await recordedReport()

    expect(report.breadcrumbs).toEqual([
      expect.objectContaining({
        name: 'self_tree_kill',
        data: expect.objectContaining({ outsideCausalWindow: true, ageMs: 1_046_666 })
      })
    ])
  })

  it('answers "was it us?" even when it was not', async () => {
    vi.setSystemTime(RENDERER_GONE_AT)

    const report = await recordedReport()

    // The absent field read as "nobody asked"; a zero reads as "we checked".
    expect(report.details).toMatchObject({
      selfInitiatedTreeKillCount: 0,
      selfInitiatedTreeKillLookbackMs: 5_000
    })
  })

  it('promotes a host spawn refusal out of the git span and into the report', async () => {
    vi.setSystemTime(RENDERER_GONE_AT - 20_000)
    for (const index of [0, 1, 2, 3]) {
      vi.setSystemTime(RENDERER_GONE_AT - 20_000 + index * 1_000)
      noteHostProcessSpawnFailure(
        'git.exe',
        Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN', syscall: 'spawn git.exe' })
      )
    }
    vi.setSystemTime(RENDERER_GONE_AT)

    const report = await recordedReport()

    expect(report.details).toMatchObject({
      hostProcessSpawnRefusedCount: 4,
      hostProcessSpawnRefusedLastAgeMs: 17_000
    })
    // The ring is 30 shared slots: a burst must cost one, not four.
    expect(
      report.breadcrumbs?.filter((crumb) => crumb.name === 'host_process_spawn_refused')
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ program: 'git.exe', suppressedSinceLast: 3 })
      })
    ])
  })
})
