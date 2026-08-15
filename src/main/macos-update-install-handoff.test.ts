import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAC_UPDATE_INSTALL_HANDOFF_MAX_AGE_MS,
  MAC_UPDATE_INSTALL_SHIPIT_APPEARANCE_MS,
  armMacUpdateInstallHandoff,
  clearMacUpdateInstallHandoff,
  findConflictingMacAppPids,
  getMacUpdateInstallHandoffPath,
  isMatchingBundleShipItRunning,
  parseSameExecutablePids,
  shouldDeferMacLaunchForUpdate
} from './macos-update-install-handoff'

const APP_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'
const APP_BUNDLE = '/Applications/Orca.app'
const SHIPIT = '/Applications/Orca.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt'
const SOURCE_RC = '1.4.160-rc.3'
const TARGET_ADHOC = '1.4.160-adhoc.20260815140533'

const tempDirectories: string[] = []

function createAppData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-update-handoff-'))
  tempDirectories.push(directory)
  return directory
}

function arm(appDataPath: string, now = 1_000_000) {
  return armMacUpdateInstallHandoff({
    appDataPath,
    executablePath: APP_EXECUTABLE,
    isPackaged: true,
    platform: 'darwin',
    sourceVersion: SOURCE_RC,
    targetVersion: TARGET_ADHOC,
    now
  })!
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('macOS update process detection', () => {
  it('finds only other main processes using the exact installed executable', () => {
    const output = [
      `  100 ${APP_EXECUTABLE}`,
      `  200 ${APP_EXECUTABLE}`,
      '  300 /Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper',
      '  400 /Applications/Orca Copy.app/Contents/MacOS/Orca'
    ].join('\n')

    expect(parseSameExecutablePids(output, APP_EXECUTABLE, 100)).toEqual([200])
  })

  it('keeps executable paths containing spaces intact', () => {
    const executable = '/Users/test/My Apps/Orca.app/Contents/MacOS/Orca'
    expect(
      parseSameExecutablePids(`  42 ${executable}\n  43 ${executable} Helper`, executable, 1)
    ).toEqual([42])
  })

  it('is macOS-only and fails stop when the macOS process table is unavailable', async () => {
    await expect(
      findConflictingMacAppPids({
        platform: 'linux',
        readProcessList: async () => `  42 ${APP_EXECUTABLE}`
      })
    ).resolves.toEqual([])
    await expect(
      findConflictingMacAppPids({
        platform: 'darwin',
        readProcessList: async () => {
          throw new Error('ps unavailable')
        }
      })
    ).resolves.toBeNull()
  })

  it('matches only this bundle’s ShipIt executable at argv zero', () => {
    expect(isMatchingBundleShipItRunning(APP_BUNDLE, `${SHIPIT} com.stablyai.orca.ShipIt`)).toBe(
      true
    )
    expect(isMatchingBundleShipItRunning(APP_BUNDLE, `/bin/zsh -c echo ${SHIPIT}`)).toBe(false)
    expect(
      isMatchingBundleShipItRunning(
        APP_BUNDLE,
        '/Applications/Other.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt'
      )
    ).toBe(false)
  })
})

describe('macOS update install handoff', () => {
  it('writes profile-independent source and exact target build identity durably', () => {
    const appDataPath = createAppData()
    arm(appDataPath)

    const marker = JSON.parse(readFileSync(getMacUpdateInstallHandoffPath(appDataPath), 'utf8'))
    expect(marker).toMatchObject({
      schemaVersion: 1,
      sourceVersion: SOURCE_RC,
      targetVersion: TARGET_ADHOC,
      targetBundlePath: APP_BUNDLE
    })
  })

  it('blocks the source build during the ShipIt appearance window', () => {
    const appDataPath = createAppData()
    const now = 1_000_000
    arm(appDataPath, now)

    expect(
      shouldDeferMacLaunchForUpdate({
        appDataPath,
        appVersion: SOURCE_RC,
        executablePath: APP_EXECUTABLE,
        isPackaged: true,
        platform: 'darwin',
        now: now + MAC_UPDATE_INSTALL_SHIPIT_APPEARANCE_MS,
        readProcessList: () => {
          throw new Error('must not probe during appearance grace')
        }
      })
    ).toBe(true)
  })

  it('blocks while this bundle’s ShipIt runs and releases after it exits', () => {
    const appDataPath = createAppData()
    const now = 1_000_000
    arm(appDataPath, now)
    const options = {
      appDataPath,
      appVersion: SOURCE_RC,
      executablePath: APP_EXECUTABLE,
      isPackaged: true,
      platform: 'darwin' as const,
      now: now + MAC_UPDATE_INSTALL_SHIPIT_APPEARANCE_MS + 1
    }

    expect(
      shouldDeferMacLaunchForUpdate({
        ...options,
        readProcessList: () => `${SHIPIT} com.stablyai.orca.ShipIt`
      })
    ).toBe(true)
    expect(
      shouldDeferMacLaunchForUpdate({ ...options, readProcessList: () => '/bin/launchd' })
    ).toBe(false)
    expect(existsSync(getMacUpdateInstallHandoffPath(appDataPath))).toBe(false)
  })

  it('keeps blocking if ShipIt state cannot be inspected after the appearance window', () => {
    const appDataPath = createAppData()
    const now = 1_000_000
    arm(appDataPath, now)

    expect(
      shouldDeferMacLaunchForUpdate({
        appDataPath,
        appVersion: SOURCE_RC,
        executablePath: APP_EXECUTABLE,
        isPackaged: true,
        platform: 'darwin',
        now: now + MAC_UPDATE_INSTALL_SHIPIT_APPEARANCE_MS + 1,
        readProcessList: () => {
          throw new Error('ps unavailable')
        }
      })
    ).toBe(true)
  })

  it('expires a stale handoff instead of trapping the source build indefinitely', () => {
    const appDataPath = createAppData()
    const now = 1_000_000
    arm(appDataPath, now)

    expect(
      shouldDeferMacLaunchForUpdate({
        appDataPath,
        appVersion: SOURCE_RC,
        executablePath: APP_EXECUTABLE,
        isPackaged: true,
        platform: 'darwin',
        now: now + MAC_UPDATE_INSTALL_HANDOFF_MAX_AGE_MS + 1,
        readProcessList: () => `${SHIPIT} com.stablyai.orca.ShipIt`
      })
    ).toBe(false)
    expect(existsSync(getMacUpdateInstallHandoffPath(appDataPath))).toBe(false)
  })

  it('does not gate a different app bundle or consume the target bundle’s handoff', () => {
    const appDataPath = createAppData()
    arm(appDataPath)

    expect(
      shouldDeferMacLaunchForUpdate({
        appDataPath,
        appVersion: SOURCE_RC,
        executablePath: '/Applications/Orca Copy.app/Contents/MacOS/Orca',
        isPackaged: true,
        platform: 'darwin',
        now: 1_000_001
      })
    ).toBe(false)
    expect(existsSync(getMacUpdateInstallHandoffPath(appDataPath))).toBe(true)
  })

  it('lets the exact ad hoc target through even though it sorts below the RC source', () => {
    const appDataPath = createAppData()
    arm(appDataPath)

    expect(
      shouldDeferMacLaunchForUpdate({
        appDataPath,
        appVersion: TARGET_ADHOC,
        executablePath: APP_EXECUTABLE,
        isPackaged: true,
        platform: 'darwin',
        now: 1_000_001,
        readProcessList: () => `${SHIPIT} com.stablyai.orca.ShipIt`
      })
    ).toBe(false)
    expect(existsSync(getMacUpdateInstallHandoffPath(appDataPath))).toBe(false)
  })

  it('blocks any unexpected bundle version until the exact target wins or ShipIt exits', () => {
    const appDataPath = createAppData()
    const now = 1_000_000
    arm(appDataPath, now)
    const options = {
      appDataPath,
      appVersion: '1.4.161',
      executablePath: APP_EXECUTABLE,
      isPackaged: true,
      platform: 'darwin' as const
    }

    expect(shouldDeferMacLaunchForUpdate({ ...options, now: now + 1 })).toBe(true)
    expect(
      shouldDeferMacLaunchForUpdate({
        ...options,
        now: now + MAC_UPDATE_INSTALL_SHIPIT_APPEARANCE_MS + 1,
        readProcessList: () => '/bin/launchd'
      })
    ).toBe(false)
    expect(existsSync(getMacUpdateInstallHandoffPath(appDataPath))).toBe(false)
  })

  it('does not let an older source handle clear a newer attempt', () => {
    const appDataPath = createAppData()
    const first = arm(appDataPath, 1_000_000)
    const second = arm(appDataPath, 1_000_001)

    clearMacUpdateInstallHandoff(first)
    expect(existsSync(second.filePath)).toBe(true)
    clearMacUpdateInstallHandoff(second)
    expect(existsSync(second.filePath)).toBe(false)
  })

  it('fails stop when the durable handoff cannot be written', () => {
    const appDataPath = createAppData()
    writeFileSync(join(appDataPath, 'com.stablyai.orca'), 'not a directory')

    expect(() => arm(appDataPath)).toThrow()
  })

  it('does nothing for unpackaged and non-macOS launches without inspecting processes', () => {
    const appDataPath = createAppData()
    expect(
      armMacUpdateInstallHandoff({
        appDataPath,
        executablePath: APP_EXECUTABLE,
        isPackaged: true,
        platform: 'linux',
        sourceVersion: SOURCE_RC,
        targetVersion: TARGET_ADHOC
      })
    ).toBeNull()
    expect(
      shouldDeferMacLaunchForUpdate({
        appDataPath,
        appVersion: SOURCE_RC,
        executablePath: APP_EXECUTABLE,
        isPackaged: false,
        platform: 'darwin',
        readProcessList: () => {
          throw new Error('must not inspect processes')
        }
      })
    ).toBe(false)
  })
})
