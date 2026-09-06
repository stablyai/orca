import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacUpdateInstallMarkerModule from '../../shared/mac-update-install-marker'
import {
  MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS,
  type MacUpdateInstallMarker
} from '../../shared/mac-update-install-marker'

const {
  markerDirRef,
  waitForMacBundleVersionChangeMock,
  readMacBundleVersionMock,
  getShipItLivenessMock,
  isProcessAliveMock
} = vi.hoisted(() => ({
  markerDirRef: { dir: '' },
  waitForMacBundleVersionChangeMock: vi.fn(),
  readMacBundleVersionMock: vi.fn(),
  getShipItLivenessMock: vi.fn(),
  isProcessAliveMock: vi.fn()
}))

vi.mock('../../shared/mac-update-install-marker', async (importOriginal) => {
  const actual = await importOriginal<typeof MacUpdateInstallMarkerModule>()
  return {
    ...actual,
    getMacUpdateInstallMarkerPath: (
      _b: string,
      m: { createdAtMs: number; requestedByPid: number; attemptId: string }
    ) => join(markerDirRef.dir, `attempt-${m.createdAtMs}-${m.requestedByPid}-${m.attemptId}.json`),
    readMacUpdateInstallMarkers: () =>
      readdirSync(markerDirRef.dir)
        .filter((f) => f.startsWith('attempt-') && f.endsWith('.json'))
        .flatMap((f) => {
          // Why the real parser: mocking it away would make every corrupt-marker test assert
          // nothing about the validation it is supposed to exercise.
          try {
            const parsed = actual.parseMacUpdateInstallMarker(
              JSON.parse(readFileSync(join(markerDirRef.dir, f), 'utf8'))
            )
            return parsed ? [parsed] : []
          } catch {
            return []
          }
        }),
    resolveMacAppBundlePath: () => '/Applications/Orca.app'
  }
})

vi.mock('./mac-app-update-bundle', () => ({
  waitForMacBundleVersionChange: waitForMacBundleVersionChangeMock,
  readMacBundleVersion: readMacBundleVersionMock
}))
vi.mock('../../shared/shipit-liveness', () => ({
  getShipItLivenessForBundle: getShipItLivenessMock,
  getProcessStartTimes: vi.fn(() => new Map()),
  isRecordedProcessAlive: isProcessAliveMock
}))

import { awaitMacUpdateInstall } from './mac-update-install-gate'

let dir: string

const writeMarker = (overrides: Partial<MacUpdateInstallMarker> = {}): void => {
  const marker: MacUpdateInstallMarker = {
    schemaVersion: 1,
    bundlePath: '/Applications/Orca.app',
    fromVersion: '1.4.194',
    targetVersion: '1.4.195',
    requestedByPid: 999,
    requestedByStartedAtMs: Date.now() - 60_000,
    createdAtMs: Date.now(),
    attemptId: 'a1b2c3d4e5f60718',
    ...overrides
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `attempt-${marker.createdAtMs}-${marker.requestedByPid}-${marker.attemptId}.json`),
    JSON.stringify(marker),
    'utf8'
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-install-gate-'))
  markerDirRef.dir = dir
  waitForMacBundleVersionChangeMock.mockReset()
  readMacBundleVersionMock.mockReset()
  readMacBundleVersionMock.mockResolvedValue('1.4.194')
  getShipItLivenessMock.mockReset()
  getShipItLivenessMock.mockReturnValue('live')
  isProcessAliveMock.mockReset()
  isProcessAliveMock.mockReturnValue(false)
  delete process.env.ORCA_OPEN_COMMAND
  delete process.env.ORCA_APP_EXECUTABLE
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('awaitMacUpdateInstall', () => {
  it('proceeds immediately when no install is in flight', async () => {
    await expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({
      kind: 'proceed'
    })
    expect(waitForMacBundleVersionChangeMock).not.toHaveBeenCalled()
  })

  it('waits for the swap instead of launching into it', async () => {
    writeMarker()
    waitForMacBundleVersionChangeMock.mockResolvedValue(true)

    const outcome = await awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')

    expect(waitForMacBundleVersionChangeMock).toHaveBeenCalledOnce()
    // 'installed' tells the caller the installer owns the relaunch, so it must not start a second app.
    expect(outcome).toEqual({ kind: 'installed', version: '1.4.195' })
    // The record survives: the app's reconcile is what reports the outcome, not this gate.
    expect(readdirSync(dir).filter((f) => f.startsWith('attempt-')).length).toBeGreaterThan(0)
  })

  it('gives up and lets the caller launch rather than locking the user out', async () => {
    // A wedged installer must never leave someone unable to open their own app.
    writeMarker()
    waitForMacBundleVersionChangeMock.mockResolvedValue(false)

    await expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'gave-up', targetVersion: '1.4.195' })
  })

  it('clears a crash-orphaned marker and proceeds rather than locking the user out', async () => {
    writeMarker({ createdAtMs: Date.now() - 60 * 60_000 })

    await expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'proceed' })
    expect(readdirSync(dir).filter((f) => f.startsWith('attempt-'))).toHaveLength(0)
    expect(waitForMacBundleVersionChangeMock).not.toHaveBeenCalled()
  })

  it('proceeds when the marker is corrupt', async () => {
    mkdirSync(dir, { recursive: true })
    // Why valid JSON that fails validation, not garbage: JSON.parse would throw before the parser
    // ever ran, so a syntax-error fixture asserts nothing about the validation it claims to cover.
    writeFileSync(
      join(dir, 'attempt-1-1-00000000000000ff.json'),
      JSON.stringify({ schemaVersion: 1, bundlePath: '/Applications/Orca.app', targetVersion: '' }),
      'utf8'
    )

    await expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'proceed' })
  })

  it('does not wait when the target version is already live', async () => {
    writeMarker()
    readMacBundleVersionMock.mockResolvedValue('1.4.195')

    await expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'proceed' })
    expect(waitForMacBundleVersionChangeMock).not.toHaveBeenCalled()
  })

  it('does not let an older sibling marker re-gate a newer installed build', async () => {
    writeMarker({ fromVersion: '1.4.194', targetVersion: '1.4.195' })
    readMacBundleVersionMock.mockResolvedValue('1.4.196')
    getShipItLivenessMock.mockReturnValue('live')

    await expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'proceed' })
    expect(waitForMacBundleVersionChangeMock).not.toHaveBeenCalled()
  })

  it('does not wait out the cap when the installer is proven gone', () => {
    // A marker left by a silent -9 abort would otherwise make every `orca open` poll for minutes.
    // requestedByPid 321 is not a live process, so the writer has exited and only ShipIt liveness
    // decides — which here says the install is over.
    writeMarker()
    getShipItLivenessMock.mockReturnValue('exited')

    return expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'proceed' })
  })

  it('fails open during the pre-spawn phase for a marker from an older installed build', () => {
    writeMarker({ requestedByStartedAtMs: undefined })
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockReturnValue(false)

    return expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'proceed' })
  })

  it('refuses to approve an unidentifiable launch target while an install is pending', () => {
    // ORCA_OPEN_COMMAND takes precedence in launchOrcaApp and its target cannot be parsed, so the
    // gate must not silently approve a launch it did not actually check.
    writeMarker()
    process.env.ORCA_OPEN_COMMAND = 'open /Applications/Something.app'

    return expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'untargetable-override' })
  })

  it('leaves dev and e2e overrides alone when no install is pending', () => {
    // Refusing whenever the override is set would break workflows that never touch an install.
    process.env.ORCA_OPEN_COMMAND = 'open /Applications/Something.app'

    return expect(
      awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca')
    ).resolves.toEqual({ kind: 'proceed' })
  })

  it('waits on a version CHANGE, not on the attempt target', () => {
    // With several attempts in flight the newest target may be one nobody is installing, so the
    // wait must key on the build we are running, not on what some attempt asked for.
    writeMarker()
    waitForMacBundleVersionChangeMock.mockResolvedValue(true)

    return awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca').then(() => {
      expect(waitForMacBundleVersionChangeMock).toHaveBeenCalledWith(
        '/Applications/Orca.app/Contents/MacOS/Orca',
        '1.4.194',
        expect.any(Number)
      )
    })
  })

  it('never waits beyond the marker absolute age cap', () => {
    writeMarker({
      createdAtMs: Date.now() - MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS + 1_000
    })
    waitForMacBundleVersionChangeMock.mockResolvedValue(false)

    return awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca').then(() => {
      expect(waitForMacBundleVersionChangeMock).toHaveBeenCalledWith(
        '/Applications/Orca.app/Contents/MacOS/Orca',
        '1.4.194',
        expect.any(Number)
      )
      expect(waitForMacBundleVersionChangeMock.mock.calls[0][2]).toBeLessThanOrEqual(1_000)
    })
  })

  it('waits during the pre-spawn window, before the installer exists', () => {
    // Pins the writerAlive wiring. Without it, reverting this gate to a bare liveness check leaves
    // the whole suite green while it launches straight into an install that is about to start.
    writeMarker()
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockReturnValue(true)
    waitForMacBundleVersionChangeMock.mockResolvedValue(true)

    return awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca').then((outcome) => {
      expect(waitForMacBundleVersionChangeMock).toHaveBeenCalled()
      expect(outcome).toEqual({ kind: 'installed', version: '1.4.195' })
    })
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
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockImplementation((pid: number) => pid === 111)
    waitForMacBundleVersionChangeMock.mockResolvedValue(true)

    return awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca').then((outcome) => {
      expect(waitForMacBundleVersionChangeMock).toHaveBeenCalledWith(
        '/Applications/Orca.app/Contents/MacOS/Orca',
        '1.4.194',
        expect.any(Number)
      )
      expect(outcome).toEqual({ kind: 'installed', version: '1.4.195' })
    })
  })

  it('leaves a failed attempt on disk so the app can still report it', () => {
    // Deleting here would lose the install_did_not_apply diagnostic.
    writeMarker()
    getShipItLivenessMock.mockReturnValue('exited')
    isProcessAliveMock.mockReturnValue(false)

    return awaitMacUpdateInstall('/Applications/Orca.app/Contents/MacOS/Orca').then(() => {
      expect(readdirSync(dir).filter((f) => f.startsWith('attempt-')).length).toBeGreaterThan(0)
    })
  })
})
