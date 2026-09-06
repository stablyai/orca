import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MacUpdateInstallMarker } from '../shared/mac-update-install-marker'

const {
  getVersionMock,
  recordUpdaterLifecycleMock,
  markerPathRef,
  getShipItLivenessMock,
  getProcessStartTimesMock,
  isProcessAliveMock
} = vi.hoisted(() => ({
  getVersionMock: vi.fn(),
  recordUpdaterLifecycleMock: vi.fn(),
  markerPathRef: { dir: '', bundle: '/Applications/Orca.app' },
  getShipItLivenessMock: vi.fn(),
  getProcessStartTimesMock: vi.fn(),
  isProcessAliveMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { getVersion: getVersionMock, isPackaged: true } }))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('../shared/shipit-liveness', () => ({
  getShipItLivenessForBundle: getShipItLivenessMock,
  getProcessStartTimes: getProcessStartTimesMock,
  isRecordedProcessAlive: isProcessAliveMock
}))
vi.mock('../shared/mac-update-install-marker', async (importOriginal) => {
  const actual = await importOriginal<typeof MarkerModule>()
  return {
    ...actual,
    getMacUpdateInstallMarkerDir: () => markerPathRef.dir,
    getMacUpdateInstallMarkerPath: (
      _bundle: string,
      m: { createdAtMs: number; requestedByPid: number; attemptId: string }
    ) =>
      join(markerPathRef.dir, `attempt-${m.createdAtMs}-${m.requestedByPid}-${m.attemptId}.json`),
    // Why mock the reader too: the real one resolves the directory through its own module-internal
    // reference, so mocking the dir getter alone would still read the real cache.
    readMacUpdateInstallMarkers: () =>
      readdirSync(markerPathRef.dir)
        .filter((f) => f.startsWith('attempt-') && f.endsWith('.json'))
        .flatMap((f) => {
          // Why the real parser: mocking it away would make every corrupt-marker test assert
          // nothing about the validation it is supposed to exercise.
          try {
            const parsed = actual.parseMacUpdateInstallMarker(
              JSON.parse(readFileSync(join(markerPathRef.dir, f), 'utf8'))
            )
            return parsed ? [parsed] : []
          } catch {
            return []
          }
        }),
    resolveMacAppBundlePath: () => markerPathRef.bundle
  }
})

import type * as MarkerModule from '../shared/mac-update-install-marker'
import {
  isMacUpdateInstallInFlight,
  markMacUpdateInstallInFlight,
  reconcileMacUpdateInstallMarker,
  shouldExitForInFlightMacUpdateInstall
} from './mac-update-install-marker'

let dir: string

const writeMarker = (overrides: Partial<MacUpdateInstallMarker> = {}): MacUpdateInstallMarker => {
  const marker: MacUpdateInstallMarker = {
    schemaVersion: 1,
    bundlePath: '/Applications/Orca.app',
    fromVersion: '1.4.194',
    targetVersion: '1.4.195',
    requestedByPid: 321,
    requestedByStartedAtMs: Date.now() - 60_000,
    createdAtMs: Date.now() - 30_000,
    attemptId: 'a1b2c3d4e5f60718',
    ...overrides
  }
  writeFileSync(
    join(dir, `attempt-${marker.createdAtMs}-${marker.requestedByPid}-${marker.attemptId}.json`),
    JSON.stringify(marker),
    'utf8'
  )
  return marker
}

const lifecycleNames = (): string[] => recordUpdaterLifecycleMock.mock.calls.map(([name]) => name)

const originalPlatform = process.platform

beforeEach(() => {
  // Why: these assert darwin-only behaviour and CI runs Linux.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  dir = mkdtempSync(join(tmpdir(), 'orca-marker-'))
  mkdirSync(dir, { recursive: true })
  markerPathRef.dir = dir
  markerPathRef.bundle = '/Applications/Orca.app'
  recordUpdaterLifecycleMock.mockReset()
  getVersionMock.mockReset()
  getShipItLivenessMock.mockReset()
  getShipItLivenessMock.mockReturnValue('live')
  getProcessStartTimesMock.mockReset()
  getProcessStartTimesMock.mockReturnValue(new Map())
  isProcessAliveMock.mockReset()
  isProcessAliveMock.mockReturnValue(false)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  rmSync(dir, { recursive: true, force: true })
})

describe('reconcileMacUpdateInstallMarker', () => {
  it('reports a silently failed install when the old version is still running', () => {
    // ShipIt writes its abort to its own log and tells the app nothing; this is the only signal.
    writeMarker()
    getVersionMock.mockReturnValue('1.4.194')

    reconcileMacUpdateInstallMarker()

    expect(lifecycleNames()).toContain('install_did_not_apply')
    expect(readdirSync(dir).filter((f) => f.startsWith('attempt-'))).toHaveLength(0)
  })

  it('records success when the target version is the one now running', () => {
    writeMarker()
    getVersionMock.mockReturnValue('1.4.195')

    reconcileMacUpdateInstallMarker()

    expect(lifecycleNames()).toContain('install_applied')
    expect(lifecycleNames()).not.toContain('install_did_not_apply')
    expect(readdirSync(dir).filter((f) => f.startsWith('attempt-'))).toHaveLength(0)
  })

  it('does nothing when no install was ever committed', () => {
    getVersionMock.mockReturnValue('1.4.195')

    reconcileMacUpdateInstallMarker()

    expect(recordUpdaterLifecycleMock).not.toHaveBeenCalled()
  })

  it('discards a marker written for a different bundle without reporting a failure', () => {
    writeMarker({ bundlePath: '/Applications/Other.app' })
    getVersionMock.mockReturnValue('1.4.194')

    reconcileMacUpdateInstallMarker()

    expect(lifecycleNames()).not.toContain('install_did_not_apply')
    expect(readdirSync(dir).filter((f) => f.startsWith('attempt-'))).toHaveLength(0)
  })
})

describe('shouldExitForInFlightMacUpdateInstall', () => {
  it('steps aside so a staged install can finish', () => {
    // Merely being this process is what cancels the update; there is no start-but-do-not-block.
    writeMarker()
    getVersionMock.mockReturnValue('1.4.194')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(true)
  })

  it('starts normally when no install is in flight', () => {
    getVersionMock.mockReturnValue('1.4.194')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })

  it('starts the already-updated build rather than refusing it', () => {
    writeMarker()
    getVersionMock.mockReturnValue('1.4.195')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })

  it('never blocks a build that is not the one being replaced', () => {
    // Blocking an unrelated version would be a lockout, not a fix.
    writeMarker({ fromVersion: '1.4.100' })
    getVersionMock.mockReturnValue('1.4.194')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })

  it('starts normally once a crash-orphaned marker has aged out', () => {
    writeMarker({ createdAtMs: Date.now() - 60 * 60_000 })
    getVersionMock.mockReturnValue('1.4.194')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })

  it('starts normally when the marker is corrupt', () => {
    // Why valid JSON that fails validation, not garbage: JSON.parse would throw before the parser
    // ever ran, so a syntax-error fixture asserts nothing about the validation it claims to cover.
    writeFileSync(
      join(dir, 'attempt-1-1-00000000000000ff.json'),
      JSON.stringify({ schemaVersion: 1, bundlePath: '/Applications/Orca.app', targetVersion: '' }),
      'utf8'
    )
    getVersionMock.mockReturnValue('1.4.194')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })

  it('ignores a marker written for a different bundle', () => {
    writeMarker({ bundlePath: '/Applications/Other.app' })
    getVersionMock.mockReturnValue('1.4.194')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })
})

describe('startup gate liveness', () => {
  it('exits during the pre-spawn window, before the installer exists', () => {
    // Pins the writerAlive wiring in the startup gate. Without it, reverting to a bare liveness
    // check leaves the suite green while a Dock launch cancels an install about to begin.
    writeMarker()
    getVersionMock.mockReturnValue('1.4.194')
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockReturnValue(true)

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(true)
  })

  it('does not let a dead same-millisecond marker mask a live pre-spawn writer', () => {
    // Per-attempt files can be created in one millisecond; filesystem order may put the dead
    // attempt first, so choosing one marker before checking liveness would reopen the race.
    const createdAtMs = Date.now()
    writeMarker({
      createdAtMs,
      requestedByPid: 111,
      attemptId: 'ffffffffffffffff',
      targetVersion: '1.4.195'
    })
    writeMarker({
      createdAtMs,
      requestedByPid: 222,
      attemptId: '0000000000000000',
      targetVersion: '1.4.196'
    })
    getVersionMock.mockReturnValue('1.4.194')
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockImplementation((pid: number) => pid === 111)

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(true)
  })

  it('starts normally when the probe could not tell — uncertainty must not exit the app', () => {
    // Taking the harmful action (exiting the app someone just launched) needs positive evidence.
    writeMarker()
    getVersionMock.mockReturnValue('1.4.194')
    getShipItLivenessMock.mockReturnValue('unverifiable')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })

  it('starts normally when the installer has already died', () => {
    // Without a liveness probe a dead installer would refuse every launch until the age cap —
    // minutes of being unable to open the app for an install that will never finish.
    writeMarker()
    getVersionMock.mockReturnValue('1.4.194')
    getShipItLivenessMock.mockReturnValue('exited')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })

  it('keeps an install committed while an older attempt is being settled', () => {
    // Reconcile reads then renames one exact attempt; a concurrently written one must survive.
    writeMarker({ targetVersion: '1.4.195', createdAtMs: Date.now() - 30_000 })
    getVersionMock.mockReturnValue('1.4.194')
    const original = reconcileMacUpdateInstallMarker
    // Simulate the race by writing another marker between read and settle.
    recordUpdaterLifecycleMock.mockImplementation(() => {
      // A live owner (this process) means the new attempt is still going.
      writeMarker({
        targetVersion: '1.4.196',
        createdAtMs: Date.now(),
        requestedByPid: process.pid
      })
    })

    original()

    expect(readdirSync(dir).filter((f) => f.startsWith('attempt-')).length).toBeGreaterThan(0)
  })
})

describe('marker directory hygiene', () => {
  it('records the kernel process identity instead of relying on wall-clock uptime math', () => {
    const startedAtMs = Date.now() - 3_600_000
    getProcessStartTimesMock.mockReturnValue(new Map([[process.pid, startedAtMs]]))
    getVersionMock.mockReturnValue('1.4.194')

    markMacUpdateInstallInFlight('1.4.196')

    const attempt = readdirSync(dir).find((name) => name.startsWith('attempt-'))
    const written = JSON.parse(readFileSync(join(dir, attempt!), 'utf8'))
    expect(written.requestedByStartedAtMs).toBe(startedAtMs)
  })

  it('drops attempt files past the age cap while leaving live ones alone', () => {
    // Per-attempt filenames make deletion safe, but a crashed attempt would otherwise leave its
    // file behind forever. Only provably expired files go.
    const expired = writeMarker({ createdAtMs: Date.now() - 60 * 60_000, requestedByPid: 111 })
    const live = writeMarker({ createdAtMs: Date.now() - 5_000, requestedByPid: 222 })
    getVersionMock.mockReturnValue('1.4.194')

    markMacUpdateInstallInFlight('1.4.196')

    const remaining = readdirSync(dir).filter((f) => f.startsWith('attempt-'))
    expect(remaining).not.toContain(
      `attempt-${expired.createdAtMs}-${expired.requestedByPid}-${expired.attemptId}.json`
    )
    expect(remaining).toContain(
      `attempt-${live.createdAtMs}-${live.requestedByPid}-${live.attemptId}.json`
    )
  })

  it('does not gate on a same-version attempt, which is indistinguishable from a finished swap', () => {
    // "target version is what is running" is how the gate knows an install completed; a
    // same-version attempt looks identical, so it cannot be gated on. Documented limitation.
    writeMarker({ targetVersion: '1.4.194' })
    getVersionMock.mockReturnValue('1.4.194')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  })

  it('prefers a differing target so a same-version marker cannot mask a real install', () => {
    writeMarker({ targetVersion: '1.4.194', createdAtMs: Date.now() - 1_000, requestedByPid: 11 })
    writeMarker({ targetVersion: '1.4.195', createdAtMs: Date.now() - 2_000, requestedByPid: 22 })
    getVersionMock.mockReturnValue('1.4.194')

    expect(shouldExitForInFlightMacUpdateInstall()).toBe(true)
  })

  it('yields a relaunch during the pre-spawn window, before the installer exists', () => {
    // This consumer used to check liveness directly and had no pre-spawn phase, so a relaunch
    // between writing the marker and ShipIt starting restarted the old build and cancelled it.
    writeMarker()
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockReturnValue(true)

    expect(isMacUpdateInstallInFlight()).toBe(true)
  })

  it('trusts its own marker when the shutdown process probe is unavailable', () => {
    getVersionMock.mockReturnValue('1.4.194')
    markMacUpdateInstallInFlight('1.4.195')
    getProcessStartTimesMock.mockReset().mockReturnValue(null)
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockReturnValue(false)

    expect(isMacUpdateInstallInFlight()).toBe(true)
    expect(getProcessStartTimesMock).toHaveBeenCalledWith([])
    expect(isProcessAliveMock).not.toHaveBeenCalled()
  })

  it('does not yield a relaunch once the writer is gone and the installer is gone', () => {
    writeMarker()
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockReturnValue(false)

    expect(isMacUpdateInstallInFlight()).toBe(false)
  })

  it('settles a reported attempt by renaming it, so its outcome is not logged twice', () => {
    // Pins settle-as-rename. If reconcile went back to unlinking, the attempt- file would simply
    // vanish and this assertion on the settled- file would fail.
    const marker = writeMarker()
    getVersionMock.mockReturnValue('1.4.194')

    reconcileMacUpdateInstallMarker()

    const names = readdirSync(dir)
    expect(names).toContain(
      `settled-${marker.createdAtMs}-${marker.requestedByPid}-${marker.attemptId}.json`
    )
    expect(names).not.toContain(
      `attempt-${marker.createdAtMs}-${marker.requestedByPid}-${marker.attemptId}.json`
    )
  })

  it('reclaims settled files by expiry, so they cannot accumulate', () => {
    // Pins the prune regex covering BOTH prefixes; an attempt-only regex leaves this file behind.
    const stale = {
      createdAtMs: Date.now() - 60 * 60_000,
      requestedByPid: 77,
      attemptId: 'bb'.repeat(8)
    }
    writeFileSync(
      join(dir, `settled-${stale.createdAtMs}-${stale.requestedByPid}-${stale.attemptId}.json`),
      '{}',
      'utf8'
    )
    getVersionMock.mockReturnValue('1.4.194')

    markMacUpdateInstallInFlight('1.4.196')

    expect(readdirSync(dir).filter((f) => f.startsWith('settled-'))).toHaveLength(0)
  })
})
