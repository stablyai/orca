import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportBreadcrumb } from '../../shared/crash-reporting'
import type * as CrashpadCaptureModule from './crashpad-capture'
import type * as DurableCrashBreadcrumbModule from './durable-crash-breadcrumb'
import type * as MainSessionExitMarkerModule from './main-session-exit-marker'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused-in-tests', isPackaged: true },
  crashReporter: { start: vi.fn() }
}))

const STREAM_TYPE_CRASHPAD_INFO = 0x43500001

/** Crashpad-layout dump whose process-level simple annotations carry `ptype`. */
function dumpWithProcessType(processType: string): Buffer {
  const regions: Buffer[] = []
  let cursor = 32 + 12
  const append = (buf: Buffer): number => {
    const rva = cursor
    regions.push(buf)
    cursor += buf.length
    return rva
  }
  const utf8 = (value: string): number => {
    const data = Buffer.from(value, 'utf8')
    const buf = Buffer.alloc(4 + data.length + 1)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return append(buf)
  }
  const keyRva = utf8('ptype')
  const valueRva = utf8(processType)
  const dict = Buffer.alloc(12)
  dict.writeUInt32LE(1, 0)
  dict.writeUInt32LE(keyRva, 4)
  dict.writeUInt32LE(valueRva, 8)
  const dictRva = append(dict)
  const info = Buffer.alloc(52)
  info.writeUInt32LE(1, 0)
  info.writeUInt32LE(dict.length, 36)
  info.writeUInt32LE(dictRva, 40)
  const infoRva = append(info)
  const header = Buffer.alloc(32 + 12)
  header.writeUInt32LE(0x504d444d, 0)
  header.writeUInt32LE(0xa793, 4)
  header.writeUInt32LE(1, 8)
  header.writeUInt32LE(32, 12)
  header.writeUInt32LE(STREAM_TYPE_CRASHPAD_INFO, 32)
  header.writeUInt32LE(info.length, 36)
  header.writeUInt32LE(infoRva, 40)
  return Buffer.concat([header, ...regions])
}

let userData: string
let dumpDir: string

beforeEach(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), 'orca-unclean-exit-'))
  dumpDir = path.join(userData, 'Crashpad')
  await mkdir(path.join(dumpDir, 'reports'), { recursive: true })
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

type Launch = {
  marker: typeof MainSessionExitMarkerModule
  crashpad: typeof CrashpadCaptureModule
  durable: typeof DurableCrashBreadcrumbModule
  launchId: string
  startedAtMs: number
  breadcrumbs: () => CrashReportBreadcrumb[]
}

/** Mirrors preflight + ready ordering, with fresh module state standing in for a new process. */
async function launch(): Promise<Launch> {
  vi.resetModules()
  const marker = await import('./main-session-exit-marker')
  const report = await import('./main-unclean-exit-report')
  const crashpad = await import('./crashpad-capture')
  const durable = await import('./durable-crash-breadcrumb')
  const store = await import('./crash-breadcrumb-store')
  const identity = (
    await import('./main-process-lifecycle-identity')
  ).getMainProcessLifecycleIdentity()
  const previous = report.startMainSessionExitTracking(userData, '1.4.217')
  crashpad.startCrashpadCapture({
    dumpDirectory: dumpDir,
    previousUncleanSessionStartedAtMs: previous ? Date.parse(previous.startedAt) : undefined
  })
  durable.recordDurableCrashBreadcrumb('main_process_lifecycle_started', {
    packaged: true
  })
  await report.reportPreviousUncleanMainExit()
  await marker._awaitMainSessionWritesForTest()
  return {
    marker,
    crashpad,
    durable,
    launchId: identity.mainProcessLaunchId,
    startedAtMs: Date.parse(identity.mainProcessStartedAt),
    breadcrumbs: () => store.getCrashBreadcrumbSnapshot()
  }
}

function uncleanExitCrumb(current: Launch): CrashReportBreadcrumb | undefined {
  return current.breadcrumbs().find((crumb) => crumb.name === 'main_previous_session_unclean_exit')
}

async function writeDump(name: string, mtimeMs: number, contents: Buffer): Promise<string> {
  const filePath = path.join(dumpDir, 'reports', name)
  await writeFile(filePath, contents)
  await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000)
  return filePath
}

describe('previous main-session unclean exit', () => {
  it('reports a killed main process and reads the browser dump before pruning', async () => {
    const first = await launch()
    // Native main-process death: no will-quit, so no exit record.
    await writeDump('browser.dmp', Date.now(), dumpWithProcessType('browser'))

    const second = await launch()
    const crumb = uncleanExitCrumb(second)

    expect(crumb?.data).toMatchObject({
      previousLaunchId: first.launchId,
      previousAppVersion: '1.4.217',
      crashpadDumpAfterStart: true,
      dumpProcessType: 'browser',
      dumpCount: 1,
      mainProcessLaunchId: second.launchId
    })
    expect(typeof crumb?.data?.previousLastBreadcrumbAt).toBe('string')
    expect(await readdir(path.join(dumpDir, 'reports'))).toEqual(['browser.dmp'])
  })

  it('reports an unclean exit with no dump when Crashpad wrote nothing', async () => {
    await launch()
    const second = await launch()
    expect(uncleanExitCrumb(second)?.data).toMatchObject({
      crashpadDumpAfterStart: false
    })
  })

  it('ignores dumps written before the previous launch started', async () => {
    const first = await launch()
    await writeDump('old.dmp', first.startedAtMs - 3_600_000, dumpWithProcessType('renderer'))
    const second = await launch()
    expect(uncleanExitCrumb(second)?.data).toMatchObject({
      crashpadDumpAfterStart: false
    })
  })

  it.each(['quit', 'update-install'] as const)('treats a %s exit as clean', async (kind) => {
    const first = await launch()
    await first.marker.recordMainSessionExit(kind)
    await writeDump('renderer.dmp', Date.now(), dumpWithProcessType('renderer'))
    const second = await launch()
    expect(uncleanExitCrumb(second)).toBeUndefined()
  })

  it.each(['relaunch', 'os-session-end', 'os-shutdown'] as const)(
    'treats a synchronous %s exit as clean',
    async (kind) => {
      const first = await launch()
      first.marker.recordMainSessionExitSync(kind)
      const second = await launch()
      expect(uncleanExitCrumb(second)).toBeUndefined()
    }
  )

  it('keeps the first exit label when a relaunch is followed by will-quit', async () => {
    const first = await launch()
    first.marker.recordMainSessionExitSync('relaunch')
    await first.marker.recordMainSessionExit('quit')
    const { readFile } = await import('node:fs/promises')
    const exitRecord = JSON.parse(
      await readFile(path.join(userData, first.marker.MAIN_SESSION_EXIT_FILE), 'utf-8')
    )
    expect(exitRecord).toMatchObject({
      launchId: first.launchId,
      kind: 'relaunch'
    })
  })

  it('commits a labelled relaunch only when will-quit records the exit', async () => {
    const first = await launch()
    first.marker.labelMainSessionExit('relaunch')
    const { readFile } = await import('node:fs/promises')
    const exitPath = path.join(userData, first.marker.MAIN_SESSION_EXIT_FILE)
    await expect(readFile(exitPath, 'utf-8')).rejects.toThrow()
    await first.marker.recordMainSessionExit('quit')
    expect(JSON.parse(await readFile(exitPath, 'utf-8'))).toMatchObject({
      launchId: first.launchId,
      kind: 'relaunch'
    })
    const second = await launch()
    expect(uncleanExitCrumb(second)).toBeUndefined()
  })

  it('reports a crash during relaunch teardown as unclean', async () => {
    const first = await launch()
    first.marker.labelMainSessionExit('relaunch')
    // Native crash before will-quit's post-teardown record.
    const second = await launch()
    expect(uncleanExitCrumb(second)?.data).toMatchObject({
      previousLaunchId: first.launchId
    })
  })

  it('keeps an OS shutdown label when the committed quit follows it', async () => {
    const first = await launch()
    first.marker.recordProvisionalMainSessionExitSync('os-shutdown')
    await first.marker.recordMainSessionExit('quit')
    const { readFile } = await import('node:fs/promises')
    const exitRecord = JSON.parse(
      await readFile(path.join(userData, first.marker.MAIN_SESSION_EXIT_FILE), 'utf-8')
    )
    expect(exitRecord).toMatchObject({
      launchId: first.launchId,
      kind: 'os-shutdown'
    })
    const second = await launch()
    expect(uncleanExitCrumb(second)).toBeUndefined()
  })

  it('reports a crash after an aborted OS shutdown as unclean', async () => {
    const first = await launch()
    first.marker.recordProvisionalMainSessionExitSync('os-shutdown')
    first.marker.revokeProvisionalMainSessionExit()
    const second = await launch()
    expect(uncleanExitCrumb(second)?.data).toMatchObject({
      previousLaunchId: first.launchId
    })
  })

  it('revokes an OS shutdown record the process outlives', async () => {
    const first = await launch()
    vi.useFakeTimers()
    try {
      first.marker.recordProvisionalMainSessionExitSync('os-shutdown', 1_000)
      vi.advanceTimersByTime(1_000)
    } finally {
      vi.useRealTimers()
    }
    const second = await launch()
    expect(uncleanExitCrumb(second)?.data).toMatchObject({
      previousLaunchId: first.launchId
    })
  })

  it('does not let an abort revoke a committed exit', async () => {
    const first = await launch()
    await first.marker.recordMainSessionExit('quit')
    first.marker.revokeProvisionalMainSessionExit()
    const second = await launch()
    expect(uncleanExitCrumb(second)).toBeUndefined()
  })

  it('records OS shutdown provisionally on non-Windows only', async () => {
    const first = await launch()
    const report = await import('./main-unclean-exit-report')
    const listeners: (() => void)[] = []
    const monitor = {
      on: vi.fn((_event: 'shutdown', listener: () => void) => listeners.push(listener))
    }
    report.installOsShutdownExitRecord(monitor, 'win32')
    expect(monitor.on).not.toHaveBeenCalled()
    report.installOsShutdownExitRecord(monitor, 'darwin')
    expect(monitor.on).toHaveBeenCalledWith('shutdown', expect.any(Function))
    listeners[0]?.()
    // Provisional: an abort still makes a later death read as unclean.
    first.marker.revokeProvisionalMainSessionExit()
    const second = await launch()
    expect(uncleanExitCrumb(second)?.data).toMatchObject({
      previousLaunchId: first.launchId
    })
  })

  it('reports nothing on a first launch', async () => {
    const first = await launch()
    expect(uncleanExitCrumb(first)).toBeUndefined()
  })

  it('does not carry a clean exit forward to a later killed launch', async () => {
    const first = await launch()
    await first.marker.recordMainSessionExit('quit')
    const second = await launch()
    expect(uncleanExitCrumb(second)).toBeUndefined()
    const third = await launch()
    expect(uncleanExitCrumb(third)?.data).toMatchObject({
      previousLaunchId: second.launchId
    })
  })

  it('ignores a corrupt launch record', async () => {
    await writeFile(path.join(userData, 'main-session-launch.json'), '{not json')
    const first = await launch()
    expect(uncleanExitCrumb(first)).toBeUndefined()
  })
})
