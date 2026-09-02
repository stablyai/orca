import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  areMacUpdateVersionsEqual,
  armMacUpdateInstallAttempt,
  decideMacUpdateInstallLaunch,
  getMacUpdateInstallAttemptPath,
  getMacUpdateInstallHeartbeatPath,
  getMacUpdateProcessIdentityState,
  MAC_UPDATE_INSTALL_ATTEMPT_MAX_AGE_MS,
  MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
  MAC_UPDATE_INSTALL_ATTEMPT_STALE_MS,
  resolveMacUpdateInstallStartup,
  writeMacUpdateInstallAttempt,
  writeMacUpdateInstallHeartbeat,
  type MacUpdateInstallAttempt
} from './mac-update-install-attempt'

const BUNDLE_PATH = '/Applications/Orca.app'
const EXECUTABLE_PATH = `${BUNDLE_PATH}/Contents/MacOS/Orca`
const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-update-probe-'))
  tempDirectories.push(directory)
  return directory
}

function createAttempt(overrides: Partial<MacUpdateInstallAttempt> = {}): MacUpdateInstallAttempt {
  return {
    schemaVersion: 1,
    attemptId: '9be0f7c8-5e0e-4a3e-9f52-8b04a41f2f1c',
    sourceVersion: '1.4.192-adhoc.20260828225951',
    targetVersion: '1.4.192',
    targetBundlePath: BUNDLE_PATH,
    sourcePid: 100,
    sourceStartedAtMs: 10_000,
    monitorPid: 101,
    monitorStartedAtMs: 11_000,
    phase: 'installing',
    createdAtMs: 1_000,
    heartbeatAtMs: 2_000,
    ...overrides
  }
}

describe('macOS update process identity state', () => {
  it('distinguishes alive, recycled-pid dead, and definitely-exited dead', () => {
    expect(getMacUpdateProcessIdentityState(100, 10_000, () => 10_000)).toBe('alive')
    expect(getMacUpdateProcessIdentityState(100, 10_000, () => 11_000)).toBe('dead')
    // A pid nothing can occupy: the probe returns null and the signal probe reports ESRCH.
    expect(getMacUpdateProcessIdentityState(2 ** 30, 10_000, () => null)).toBe('dead')
  })

  it('reports unverifiable, not dead, when the probe fails against a live process', () => {
    expect(
      getMacUpdateProcessIdentityState(process.pid, 10_000, () => {
        throw new Error('ps exploded')
      })
    ).toBe('unverifiable')
    expect(getMacUpdateProcessIdentityState(process.pid, 10_000, () => null)).toBe('unverifiable')
  })
})

describe('macOS update install startup probes', () => {
  it('keeps blocking while the monitor is unverifiable instead of assuming it exited', () => {
    const appDataPath = createTempDir()
    const attempt = createAttempt({ monitorPid: process.pid })
    writeMacUpdateInstallAttempt(getMacUpdateInstallAttemptPath(appDataPath), attempt)

    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: attempt.sourceVersion,
        executablePath: EXECUTABLE_PATH,
        isPackaged: true,
        platform: 'darwin',
        nowMs: 3_000,
        readProcessStartedAtMs: () => {
          throw new Error('transient ps failure')
        },
        readProcessList: () => ''
      })
    ).toEqual({ action: 'block', reason: 'active-install' })
  })

  it('fails open to a plain allow when the startup probe itself throws', () => {
    const appDataPath = createTempDir()
    writeMacUpdateInstallAttempt(getMacUpdateInstallAttemptPath(appDataPath), createAttempt())

    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: '1.4.191',
        // Not inside an .app bundle: bundle resolution throws inside the probe.
        executablePath: '/usr/local/bin/orca',
        isPackaged: true,
        platform: 'darwin',
        nowMs: 3_000,
        readProcessStartedAtMs: () => null,
        readProcessList: () => ''
      })
    ).toEqual({ action: 'allow', reason: 'no-attempt' })
  })

  it('honors a fresh sibling-file heartbeat when the attempt record heartbeat is stale', () => {
    const appDataPath = createTempDir()
    const attemptPath = getMacUpdateInstallAttemptPath(appDataPath)
    const attempt = createAttempt({ heartbeatAtMs: 1_000 })
    writeMacUpdateInstallAttempt(attemptPath, attempt)
    const nowMs = 1_000 + MAC_UPDATE_INSTALL_ATTEMPT_STALE_MS + 10_000
    writeMacUpdateInstallHeartbeat(attemptPath, {
      schemaVersion: MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
      attemptId: attempt.attemptId,
      heartbeatAtMs: nowMs - 1_000
    })

    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: attempt.sourceVersion,
        executablePath: EXECUTABLE_PATH,
        isPackaged: true,
        platform: 'darwin',
        nowMs,
        readProcessStartedAtMs: () => attempt.monitorStartedAtMs + 1_000,
        readProcessList: () => ''
      })
    ).toEqual({ action: 'block', reason: 'active-install' })
  })

  it('ignores a heartbeat that belongs to a different attempt', () => {
    const appDataPath = createTempDir()
    const attemptPath = getMacUpdateInstallAttemptPath(appDataPath)
    const attempt = createAttempt({ heartbeatAtMs: 1_000 })
    writeMacUpdateInstallAttempt(attemptPath, attempt)
    const nowMs = 1_000 + MAC_UPDATE_INSTALL_ATTEMPT_STALE_MS + 10_000
    writeMacUpdateInstallHeartbeat(attemptPath, {
      schemaVersion: MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
      attemptId: 'some-other-attempt',
      heartbeatAtMs: nowMs - 1_000
    })

    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: attempt.sourceVersion,
        executablePath: EXECUTABLE_PATH,
        isPackaged: true,
        platform: 'darwin',
        nowMs,
        readProcessStartedAtMs: () => attempt.monitorStartedAtMs + 1_000,
        readProcessList: () => ''
      })
    ).toEqual({
      action: 'allow-with-failure',
      reason: 'install-abandoned',
      failureReason: 'monitor-exited'
    })
  })
})

describe('macOS update startup ShipIt probe', () => {
  it('keeps blocking on an unverified process list, bounded by the age cap', () => {
    const appDataPath = createTempDir()
    const attemptPath = getMacUpdateInstallAttemptPath(appDataPath)
    const attempt = createAttempt({ heartbeatAtMs: 1_000 })
    writeMacUpdateInstallAttempt(attemptPath, attempt)
    const options = {
      appDataPath,
      appVersion: attempt.sourceVersion,
      executablePath: EXECUTABLE_PATH,
      isPackaged: true,
      platform: 'darwin' as const,
      // Monitor verifiably dead and heartbeat stale: the process list is the last defense.
      readProcessStartedAtMs: () => attempt.monitorStartedAtMs + 1_000
    }
    const failingProbes: (() => string | null)[] = [
      () => null,
      () => {
        throw new Error('ps timed out')
      }
    ]
    for (const readProcessList of failingProbes) {
      expect(
        resolveMacUpdateInstallStartup({
          ...options,
          nowMs: 1_000 + MAC_UPDATE_INSTALL_ATTEMPT_STALE_MS + 10_000,
          readProcessList
        })
      ).toEqual({ action: 'block', reason: 'shipit-unverifiable' })
    }
    expect(
      resolveMacUpdateInstallStartup({
        ...options,
        nowMs: attempt.createdAtMs + MAC_UPDATE_INSTALL_ATTEMPT_MAX_AGE_MS + 1,
        readProcessList: () => null
      })
    ).toEqual({
      action: 'allow-with-failure',
      reason: 'install-abandoned',
      failureReason: 'install-timed-out'
    })
  })
})

describe('macOS update gate under a backward clock step', () => {
  it('keeps verified liveness checks active and does not strand once they clear', () => {
    const attempt = createAttempt({ createdAtMs: 3_600_000, heartbeatAtMs: 3_600_000 })
    const base = {
      attempt,
      currentBundlePath: BUNDLE_PATH,
      currentVersion: attempt.sourceVersion,
      nowMs: 5_000
    }
    expect(decideMacUpdateInstallLaunch({ ...base, monitorAlive: true, shipIt: 'absent' })).toEqual(
      { action: 'block', reason: 'active-install' }
    )
    expect(decideMacUpdateInstallLaunch({ ...base, monitorAlive: false, shipIt: 'alive' })).toEqual(
      { action: 'block', reason: 'shipit-alive' }
    )
    // A heartbeat an hour in the "future" is not proof of life once nothing verifiable is running.
    expect(
      decideMacUpdateInstallLaunch({ ...base, monitorAlive: false, shipIt: 'absent' })
    ).toEqual({
      action: 'allow-with-failure',
      reason: 'install-abandoned',
      failureReason: 'monitor-exited'
    })
  })
})

describe('macOS update version equality', () => {
  it('treats formatting variants of the same version as installed', () => {
    expect(areMacUpdateVersionsEqual('v1.4.192', '1.4.192')).toBe(true)
    expect(areMacUpdateVersionsEqual('1.4.192+build.7', '1.4.192')).toBe(true)
    expect(areMacUpdateVersionsEqual('1.4.192', '1.4.193')).toBe(false)
    expect(areMacUpdateVersionsEqual('not-a-version', 'also-not')).toBe(false)

    expect(
      decideMacUpdateInstallLaunch({
        attempt: createAttempt({ targetVersion: '1.4.192' }),
        currentBundlePath: BUNDLE_PATH,
        currentVersion: 'v1.4.192',
        nowMs: 3_000,
        monitorAlive: true,
        shipIt: 'alive'
      })
    ).toEqual({ action: 'allow-and-clear', reason: 'target-installed' })
  })
})

describe('macOS update orphan heartbeat', () => {
  it('reclaims a heartbeat file that has no attempt record', () => {
    const appDataPath = createTempDir()
    const attemptPath = getMacUpdateInstallAttemptPath(appDataPath)
    writeMacUpdateInstallHeartbeat(attemptPath, {
      schemaVersion: MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
      attemptId: 'orphaned-attempt',
      heartbeatAtMs: 5_000
    })

    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: '1.4.191',
        executablePath: EXECUTABLE_PATH,
        isPackaged: true,
        platform: 'darwin',
        nowMs: 6_000,
        readProcessStartedAtMs: () => null,
        readProcessList: () => ''
      })
    ).toEqual({ action: 'allow', reason: 'no-attempt' })
    expect(existsSync(getMacUpdateInstallHeartbeatPath(attemptPath))).toBe(false)
  })
})

describe('macOS update install arming identity', () => {
  it.runIf(process.platform === 'darwin')(
    'refuses to fence on a spawned pid whose recorded start time is implausible',
    () => {
      const resourcesPath = createTempDir()
      const monitorDirectory = join(resourcesPath, 'app.asar.unpacked', 'out', 'main')
      mkdirSync(monitorDirectory, { recursive: true })
      writeFileSync(join(monitorDirectory, 'mac-update-install-monitor-entry.js'), '')
      const appDataPath = createTempDir()

      expect(() =>
        armMacUpdateInstallAttempt({
          appDataPath,
          executablePath: '/bin/sleep',
          isPackaged: true,
          platform: 'darwin',
          resourcesPath,
          sourceVersion: '1.4.191',
          targetVersion: '1.4.192',
          nowMs: Date.now(),
          readProcessStartedAtMs: () => Date.now() - 10 * 60_000
        })
      ).toThrow('monitor identity')
    }
  )
})
