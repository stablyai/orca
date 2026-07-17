import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_INSTALL_HANDOFF_ARMING_MS,
  UPDATE_INSTALL_HANDOFF_MAX_AGE_MS,
  clearUpdateInstallHandoffMarker,
  getUpdateInstallHandoffMarkerPath,
  isBundleShipItRunning,
  shouldDeferLaunchForUpdateInstall,
  writeUpdateInstallHandoffMarker
} from './update-install-launch-gate'

const execFileSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

const APP_BIN = '/Applications/Orca.app/Contents/MacOS/Orca'
const SHIPIT_PATH = '/Applications/Orca.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt'
const SHIPIT_ROW = `${SHIPIT_PATH} com.stablyai.orca.ShipIt`

const tempDirs: string[] = []

function makeAppData(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-launch-gate-'))
  tempDirs.push(dir)
  return dir
}

function markerFile(appData: string, executablePath = APP_BIN): string {
  return getUpdateInstallHandoffMarkerPath(appData, executablePath)
}

afterEach(() => {
  execFileSyncMock.mockReset()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('isBundleShipItRunning', () => {
  it('matches only this bundle’s Squirrel installer', () => {
    const otherBundle =
      '/Applications/Other.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt'
    expect(isBundleShipItRunning(APP_BIN, `${otherBundle}\n/usr/bin/ps`)).toBe(false)
    expect(isBundleShipItRunning(APP_BIN, `/usr/bin/ps\n${SHIPIT_ROW}`)).toBe(true)
  })

  it('ignores processes that merely mention the installer path in arguments', () => {
    const grepRow = `/bin/zsh -c grep ${SHIPIT_ROW}`
    expect(isBundleShipItRunning(APP_BIN, grepRow)).toBe(false)
  })

  it('does not accept another executable whose path only shares the ShipIt prefix', () => {
    expect(isBundleShipItRunning(APP_BIN, `${SHIPIT_PATH}-backup update`)).toBe(false)
  })
})

describe('shouldDeferLaunchForUpdateInstall', () => {
  it('reads all users so a privileged ShipIt install is visible', () => {
    const appData = makeAppData()
    const createdAt = 1_000_000
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', createdAt)
    execFileSyncMock.mockReturnValue(SHIPIT_ROW)

    const defer = shouldDeferLaunchForUpdateInstall({
      isPackaged: true,
      appDataPath: appData,
      appVersion: '1.0.51',
      deps: {
        platform: 'darwin',
        executablePath: APP_BIN,
        now: createdAt + UPDATE_INSTALL_HANDOFF_ARMING_MS + 1
      }
    })

    expect(defer).toBe(true)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      '/bin/ps',
      ['-axo', 'command='],
      expect.objectContaining({ encoding: 'utf8' })
    )
  })

  it('defers during marker arming without waiting for a process-table read', () => {
    const appData = makeAppData()
    const createdAt = 1_000_000
    const readProcessList = vi.fn(() => '/usr/bin/ps')
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', createdAt)

    const defer = shouldDeferLaunchForUpdateInstall({
      isPackaged: true,
      appDataPath: appData,
      appVersion: '1.0.51',
      deps: {
        platform: 'darwin',
        executablePath: APP_BIN,
        now: createdAt + UPDATE_INSTALL_HANDOFF_ARMING_MS,
        readProcessList
      }
    })

    expect(defer).toBe(true)
    expect(readProcessList).not.toHaveBeenCalled()
  })

  it('defers a same-version launch while this bundle’s installer is alive', () => {
    const appData = makeAppData()
    const createdAt = 1_000_000
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', createdAt)

    const defer = shouldDeferLaunchForUpdateInstall({
      isPackaged: true,
      appDataPath: appData,
      appVersion: '1.0.51',
      deps: {
        platform: 'darwin',
        executablePath: APP_BIN,
        now: createdAt + UPDATE_INSTALL_HANDOFF_ARMING_MS + 1,
        readProcessList: () => SHIPIT_ROW
      }
    })

    expect(defer).toBe(true)
    expect(existsSync(markerFile(appData))).toBe(true)
  })

  it('shares the bundle-scoped marker across isolated userData profiles', () => {
    const appData = makeAppData()
    const createdAt = 1_000_000
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', createdAt)

    const deferFromIsolatedProfile = shouldDeferLaunchForUpdateInstall({
      isPackaged: true,
      appDataPath: appData,
      appVersion: '1.0.51',
      deps: {
        platform: 'darwin',
        executablePath: APP_BIN,
        now: createdAt + 1,
        readProcessList: () => '/usr/bin/ps'
      }
    })

    expect(deferFromIsolatedProfile).toBe(true)
  })

  it('does not share markers between side-by-side app bundles', () => {
    const appData = makeAppData()
    const otherAppBin = '/Applications/Orca Preview.app/Contents/MacOS/Orca'
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', 1_000_000)

    expect(
      shouldDeferLaunchForUpdateInstall({
        isPackaged: true,
        appDataPath: appData,
        appVersion: '1.0.51',
        deps: {
          platform: 'darwin',
          executablePath: otherAppBin,
          now: 1_000_001,
          readProcessList: () => SHIPIT_ROW
        }
      })
    ).toBe(false)
    expect(existsSync(markerFile(appData))).toBe(true)
  })

  it('lets the post-update relaunch through and clears the marker', () => {
    const appData = makeAppData()
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51')

    const defer = shouldDeferLaunchForUpdateInstall({
      isPackaged: true,
      appDataPath: appData,
      appVersion: '1.0.61',
      deps: { platform: 'darwin', executablePath: APP_BIN, readProcessList: () => SHIPIT_ROW }
    })

    expect(defer).toBe(false)
    expect(existsSync(markerFile(appData))).toBe(false)
  })

  it('launches normally once the installer has exited (aborted/failed install)', () => {
    const appData = makeAppData()
    const createdAt = 1_000_000
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', createdAt)

    const defer = shouldDeferLaunchForUpdateInstall({
      isPackaged: true,
      appDataPath: appData,
      appVersion: '1.0.51',
      deps: {
        platform: 'darwin',
        executablePath: APP_BIN,
        now: createdAt + UPDATE_INSTALL_HANDOFF_ARMING_MS + 1,
        readProcessList: () => '/usr/bin/ps'
      }
    })

    expect(defer).toBe(false)
    expect(existsSync(markerFile(appData))).toBe(false)
  })

  it('expires stale markers instead of gating launches', () => {
    const appData = makeAppData()
    const staleCreatedAt = 1_000_000
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', staleCreatedAt)

    const defer = shouldDeferLaunchForUpdateInstall({
      isPackaged: true,
      appDataPath: appData,
      appVersion: '1.0.51',
      deps: {
        platform: 'darwin',
        executablePath: APP_BIN,
        now: staleCreatedAt + UPDATE_INSTALL_HANDOFF_MAX_AGE_MS + 1,
        readProcessList: () => SHIPIT_ROW
      }
    })

    expect(defer).toBe(false)
    expect(existsSync(markerFile(appData))).toBe(false)
  })

  it('fails open on corrupt markers, unreadable process tables, and other platforms', () => {
    const appData = makeAppData()
    mkdirSync(path.dirname(markerFile(appData)), { recursive: true })
    writeFileSync(markerFile(appData), 'not json')
    expect(
      shouldDeferLaunchForUpdateInstall({
        isPackaged: true,
        appDataPath: appData,
        appVersion: '1.0.51',
        deps: { platform: 'darwin', executablePath: APP_BIN, readProcessList: () => SHIPIT_ROW }
      })
    ).toBe(false)

    const createdAt = 1_000_000
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', createdAt)
    expect(
      shouldDeferLaunchForUpdateInstall({
        isPackaged: true,
        appDataPath: appData,
        appVersion: '1.0.51',
        deps: {
          platform: 'darwin',
          executablePath: APP_BIN,
          now: createdAt + UPDATE_INSTALL_HANDOFF_ARMING_MS + 1,
          readProcessList: () => {
            throw new Error('ps timed out')
          }
        }
      })
    ).toBe(false)

    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51')
    expect(
      shouldDeferLaunchForUpdateInstall({
        isPackaged: true,
        appDataPath: appData,
        appVersion: '1.0.51',
        deps: { platform: 'win32', executablePath: APP_BIN, readProcessList: () => SHIPIT_ROW }
      })
    ).toBe(false)

    expect(
      shouldDeferLaunchForUpdateInstall({
        isPackaged: false,
        appDataPath: appData,
        appVersion: '1.0.51',
        deps: { platform: 'darwin', executablePath: APP_BIN, readProcessList: () => SHIPIT_ROW }
      })
    ).toBe(false)
  })

  it('fails open and clears a marker timestamped in the future', () => {
    const appData = makeAppData()
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51', 2_000_000)

    expect(
      shouldDeferLaunchForUpdateInstall({
        isPackaged: true,
        appDataPath: appData,
        appVersion: '1.0.51',
        deps: { platform: 'darwin', executablePath: APP_BIN, now: 1_000_000 }
      })
    ).toBe(false)
    expect(existsSync(markerFile(appData))).toBe(false)
  })

  it('clearUpdateInstallHandoffMarker removes the marker', () => {
    const appData = makeAppData()
    writeUpdateInstallHandoffMarker(appData, APP_BIN, '1.0.51')
    clearUpdateInstallHandoffMarker(appData, APP_BIN)
    expect(existsSync(markerFile(appData))).toBe(false)
  })
})
