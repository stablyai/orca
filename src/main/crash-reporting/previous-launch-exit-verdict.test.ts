import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLocalFileSink } from '../observability/local-file-sink'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import {
  recordCommittedQuitBreadcrumb,
  recordRelaunchExitBreadcrumb
} from './committed-quit-breadcrumb'
import { CrashReportStore } from './crash-report-store'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import {
  annotateAbruptlyEndedLaunchReports,
  findPreviousLaunchExit,
  loadPreviousLaunchExit,
  previousLaunchExitDetails,
  setPreviousLaunchExitForTest
} from './previous-launch-exit-verdict'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-launch-exit-'))
  tempDirs.push(dir)
  return dir
}

/** Writes real durable crumbs through the real sink, then reads the file back —
 *  the writer's span shape is the reader's only contract. */
async function traceFileFromRealBreadcrumbs(write: () => void): Promise<string> {
  const filePath = path.join(await tempDir(), 'main.trace.ndjson')
  const sink = createLocalFileSink({ filePath })
  setActiveSink(sink)
  try {
    write()
  } finally {
    sink.flush()
    sink.close()
    _resetTracerForTests()
  }
  return filePath
}

function breadcrumbLine(name: string, launchId: string, schema: number | null = 1): string {
  return JSON.stringify({
    type: 'effect-span',
    name: 'crash.breadcrumb',
    attributes: {
      kind: 'crash-breadcrumb',
      'breadcrumb.name': name,
      'breadcrumb.data': { mainProcessLaunchId: launchId },
      ...(schema === null ? {} : { 'breadcrumb.schema': schema })
    }
  })
}

beforeEach(() => {
  clearCrashBreadcrumbsForTest()
  setPreviousLaunchExitForTest(null)
})

afterEach(async () => {
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  setPreviousLaunchExitForTest(null)
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('loadPreviousLaunchExit', () => {
  it('reads a committed quit written by the real quit path as an orderly exit', async () => {
    const filePath = await traceFileFromRealBreadcrumbs(() => {
      recordDurableCrashBreadcrumb('main_process_lifecycle_started', { platform: 'win32' })
      recordCommittedQuitBreadcrumb({
        quittingForUpdate: false,
        devParentShutdownRequested: false,
        systemSessionEnding: false
      })
    })

    await expect(loadPreviousLaunchExit(randomUUID(), [filePath])).resolves.toEqual({
      previousLaunchId: getMainProcessLifecycleIdentity().mainProcessLaunchId,
      diedAbruptly: false
    })
  })

  // A GPU-fallback or renderer-requested restart leaves through app.exit(), which fires
  // no quit event at all — the launch it ends is deliberate, not killed.
  it('reads a relaunch that skipped the quit pipeline as an orderly exit too', async () => {
    const filePath = await traceFileFromRealBreadcrumbs(() => {
      recordDurableCrashBreadcrumb('main_process_lifecycle_started', { platform: 'win32' })
      recordRelaunchExitBreadcrumb()
    })

    await expect(loadPreviousLaunchExit(randomUUID(), [filePath])).resolves.toMatchObject({
      diedAbruptly: false
    })
  })

  it('calls a launch that never wrote the quit crumb an abrupt death', async () => {
    const filePath = await traceFileFromRealBreadcrumbs(() => {
      recordDurableCrashBreadcrumb('main_process_lifecycle_started', { platform: 'win32' })
      recordDurableCrashBreadcrumb('renderer_memory_highwater', { thresholdPct: 90 })
    })

    await expect(loadPreviousLaunchExit(randomUUID(), [filePath])).resolves.toEqual({
      previousLaunchId: getMainProcessLifecycleIdentity().mainProcessLaunchId,
      diedAbruptly: true
    })
  })

  it('falls through to the rotated file when the newest one holds no other launch', async () => {
    const missing = path.join(await tempDir(), 'absent.ndjson')
    const filePath = await traceFileFromRealBreadcrumbs(() => {
      recordDurableCrashBreadcrumb('main_process_lifecycle_started', { platform: 'win32' })
    })

    await expect(loadPreviousLaunchExit(randomUUID(), [missing, filePath])).resolves.toMatchObject({
      diedAbruptly: true
    })
  })

  it('has no verdict when nothing on disk names another launch', async () => {
    const filePath = await traceFileFromRealBreadcrumbs(() => {
      recordDurableCrashBreadcrumb('main_process_lifecycle_started', { platform: 'win32' })
    })
    const currentLaunchId = getMainProcessLifecycleIdentity().mainProcessLaunchId

    await expect(loadPreviousLaunchExit(currentLaunchId, [filePath])).resolves.toBeNull()
  })
})

describe('findPreviousLaunchExit', () => {
  it('reads only the newest other launch, not the one before it', () => {
    const previous = randomUUID()
    const older = randomUUID()
    const tail = [
      breadcrumbLine('main_process_quit_committed', older),
      breadcrumbLine('main_process_lifecycle_started', previous),
      breadcrumbLine('renderer_memory_highwater', previous)
    ].join('\n')

    expect(findPreviousLaunchExit(tail, randomUUID())).toEqual({
      previousLaunchId: previous,
      diedAbruptly: true
    })
  })

  it('ignores this launch’s own crumbs and the half-line a kill leaves behind', () => {
    const current = randomUUID()
    const previous = randomUUID()
    const tail = [
      '{"name":"crash.breadcrumb","attribu',
      breadcrumbLine('main_process_quit_committed', previous),
      breadcrumbLine('main_process_lifecycle_started', current)
    ].join('\n')

    expect(findPreviousLaunchExit(tail, current)).toEqual({
      previousLaunchId: previous,
      diedAbruptly: false
    })
  })

  // Without this the first launch after every upgrade reports the launch before it as
  // an abrupt death, because that build had no quit crumb to write in the first place.
  it('names a launch whose build predates the quit crumb without judging how it ended', () => {
    const previous = randomUUID()
    const tail = [
      breadcrumbLine('main_process_lifecycle_started', previous, null),
      breadcrumbLine('renderer_recovery_reload', previous, null)
    ].join('\n')

    expect(findPreviousLaunchExit(tail, randomUUID())).toEqual({ previousLaunchId: previous })
  })

  it('still finds the quit crumb behind the crumbs teardown emits after it', () => {
    const previous = randomUUID()
    const tail = [
      breadcrumbLine('main_process_quit_committed', previous),
      ...Array.from({ length: 20 }, () => breadcrumbLine('process_gone_suppressed', previous))
    ].join('\n')

    expect(findPreviousLaunchExit(tail, randomUUID())).toMatchObject({ diedAbruptly: false })
  })
})

describe('previousLaunchExitDetails', () => {
  it('publishes nothing when no verdict was reached', () => {
    expect(previousLaunchExitDetails()).toEqual({})
  })

  it('names an unjudged launch without claiming it died', () => {
    setPreviousLaunchExitForTest({ previousLaunchId: 'launch-a' })

    expect(previousLaunchExitDetails()).toEqual({ previousMainProcessLaunchId: 'launch-a' })
  })

  it('names the previous launch and its fate', () => {
    setPreviousLaunchExitForTest({ previousLaunchId: 'launch-a', diedAbruptly: true })

    expect(previousLaunchExitDetails()).toEqual({
      previousMainProcessLaunchId: 'launch-a',
      previousMainProcessDiedAbruptly: true
    })
  })
})

describe('annotateAbruptlyEndedLaunchReports', () => {
  async function storeWithReport(launchId: string): Promise<CrashReportStore> {
    const store = new CrashReportStore(path.join(await tempDir(), 'crash-reports.json'))
    await store.record({
      source: 'renderer',
      processType: 'renderer',
      reason: 'killed',
      exitCode: 1,
      appVersion: '1.4.200',
      platform: 'win32',
      osRelease: '10.0.26100',
      arch: 'x64',
      electronVersion: '38.0.0',
      chromeVersion: '140.0.0',
      details: {
        mainProcessLaunchId: launchId,
        processMetricsBrowserCount: 1,
        processMetricsCrashedProcessAbsent: true
      }
    })
    return store
  }

  it('stamps the dead launch’s own reports, next to the census that says it survived', async () => {
    const store = await storeWithReport('launch-a')

    await annotateAbruptlyEndedLaunchReports(store, {
      previousLaunchId: 'launch-a',
      diedAbruptly: true
    })

    const [report] = await store.listRecent()
    expect(report.details).toMatchObject({
      mainProcessDiedAbruptly: true,
      processMetricsBrowserCount: 1
    })
  })

  it('leaves reports from a different launch, an orderly exit, and an unjudged one alone', async () => {
    const store = await storeWithReport('launch-a')

    await annotateAbruptlyEndedLaunchReports(store, {
      previousLaunchId: 'launch-b',
      diedAbruptly: true
    })
    await annotateAbruptlyEndedLaunchReports(store, {
      previousLaunchId: 'launch-a',
      diedAbruptly: false
    })
    await annotateAbruptlyEndedLaunchReports(store, { previousLaunchId: 'launch-a' })

    const [report] = await store.listRecent()
    expect(report.details.mainProcessDiedAbruptly).toBeUndefined()
  })
})
