import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decideMacUpdateInstallLaunch,
  getMacUpdateInstallAttemptPath,
  isMacUpdateProcessIdentityAlive,
  readMacUpdateInstallAttempt,
  resolveMacUpdateInstallStartup,
  writeMacUpdateInstallAttempt,
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

describe('macOS update install ownership', () => {
  it('blocks only a source-version launch of the exact bundle during an active install', () => {
    const attempt = createAttempt()

    expect(
      decideMacUpdateInstallLaunch({
        attempt,
        currentBundlePath: BUNDLE_PATH,
        currentVersion: attempt.sourceVersion,
        nowMs: 2_500,
        monitorAlive: true,
        shipIt: 'alive'
      })
    ).toEqual({ action: 'block', reason: 'active-install' })

    expect(
      decideMacUpdateInstallLaunch({
        attempt,
        currentBundlePath: BUNDLE_PATH,
        currentVersion: attempt.targetVersion,
        nowMs: 2_500,
        monitorAlive: true,
        shipIt: 'alive'
      })
    ).toEqual({ action: 'allow-and-clear', reason: 'target-installed' })

    expect(
      decideMacUpdateInstallLaunch({
        attempt,
        currentBundlePath: '/Applications/Orca Test.app',
        currentVersion: attempt.sourceVersion,
        nowMs: 2_500,
        monitorAlive: true,
        shipIt: 'alive'
      })
    ).toEqual({ action: 'allow', reason: 'different-bundle' })
  })

  it('recovers a stale failed attempt without creating an install loop', () => {
    const attempt = createAttempt({ heartbeatAtMs: 2_000 })

    expect(
      decideMacUpdateInstallLaunch({
        attempt,
        currentBundlePath: BUNDLE_PATH,
        currentVersion: attempt.sourceVersion,
        nowMs: 20_001,
        monitorAlive: false,
        shipIt: 'absent'
      })
    ).toEqual({
      action: 'allow-with-failure',
      reason: 'install-abandoned',
      failureReason: 'monitor-exited'
    })

    expect(
      decideMacUpdateInstallLaunch({
        attempt,
        currentBundlePath: BUNDLE_PATH,
        currentVersion: attempt.sourceVersion,
        nowMs: 20_001,
        monitorAlive: false,
        shipIt: 'alive'
      })
    ).toEqual({ action: 'block', reason: 'shipit-alive' })
  })

  it('surfaces an expired attempt as a timeout instead of silently reopening', () => {
    const attempt = createAttempt()

    expect(
      decideMacUpdateInstallLaunch({
        attempt,
        currentBundlePath: BUNDLE_PATH,
        currentVersion: attempt.sourceVersion,
        nowMs: attempt.createdAtMs + 15 * 60_000 + 1,
        monitorAlive: false,
        shipIt: 'absent'
      })
    ).toEqual({
      action: 'allow-with-failure',
      reason: 'install-abandoned',
      failureReason: 'install-timed-out'
    })
  })

  it('allows exactly one recovery launch after a recorded installer failure', () => {
    const attempt = createAttempt({
      phase: 'failed',
      failureReason: 'installer-exited-with-source-version'
    })

    expect(
      decideMacUpdateInstallLaunch({
        attempt,
        currentBundlePath: BUNDLE_PATH,
        currentVersion: attempt.sourceVersion,
        nowMs: 3_000,
        monitorAlive: false,
        shipIt: 'absent'
      })
    ).toEqual({
      action: 'allow-with-failure',
      reason: 'recorded-failure',
      failureReason: 'installer-exited-with-source-version'
    })
  })

  it('persists the gate outside profile userData and consumes recovery once', () => {
    const appDataPath = mkdtempSync(join(tmpdir(), 'orca-update-attempt-'))
    tempDirectories.push(appDataPath)
    const attemptPath = getMacUpdateInstallAttemptPath(appDataPath)
    const attempt = createAttempt({
      sourcePid: process.pid,
      monitorPid: process.pid,
      phase: 'failed',
      failureReason: 'installer-exited-with-source-version'
    })
    writeMacUpdateInstallAttempt(attemptPath, attempt)

    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: attempt.sourceVersion,
        executablePath: EXECUTABLE_PATH,
        isPackaged: true,
        platform: 'darwin',
        nowMs: 3_000,
        readProcessStartedAtMs: () => null,
        readProcessList: () => ''
      })
    ).toEqual({
      action: 'allow-with-failure',
      reason: 'recorded-failure',
      failureReason: 'installer-exited-with-source-version'
    })
    expect(existsSync(attemptPath)).toBe(false)
    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: attempt.sourceVersion,
        executablePath: EXECUTABLE_PATH,
        isPackaged: true,
        platform: 'darwin'
      })
    ).toEqual({ action: 'allow', reason: 'no-attempt' })
  })

  it('keeps the exact bundle gated while the monitor owns the handoff', () => {
    const appDataPath = mkdtempSync(join(tmpdir(), 'orca-update-attempt-'))
    tempDirectories.push(appDataPath)
    const attemptPath = getMacUpdateInstallAttemptPath(appDataPath)
    const attempt = createAttempt({ sourcePid: process.pid, monitorPid: process.pid })
    writeMacUpdateInstallAttempt(attemptPath, attempt)

    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: attempt.sourceVersion,
        executablePath: EXECUTABLE_PATH,
        isPackaged: true,
        platform: 'darwin',
        nowMs: 3_000,
        readProcessStartedAtMs: () => attempt.monitorStartedAtMs,
        readProcessList: () => {
          throw new Error('monitor ownership avoids process enumeration')
        }
      })
    ).toEqual({ action: 'block', reason: 'active-install' })
    expect(existsSync(attemptPath)).toBe(true)
  })

  it('does not treat a reused monitor or source pid as the recorded process', () => {
    const attempt = createAttempt()

    expect(
      isMacUpdateProcessIdentityAlive(
        attempt.monitorPid,
        attempt.monitorStartedAtMs,
        () => attempt.monitorStartedAtMs + 1_000
      )
    ).toBe(false)
    expect(
      isMacUpdateProcessIdentityAlive(
        attempt.sourcePid,
        attempt.sourceStartedAtMs,
        () => attempt.sourceStartedAtMs + 1_000
      )
    ).toBe(false)
  })

  it('does not let a reused monitor pid prolong a stale startup fence', () => {
    const appDataPath = mkdtempSync(join(tmpdir(), 'orca-update-attempt-'))
    tempDirectories.push(appDataPath)
    const attempt = createAttempt()
    writeMacUpdateInstallAttempt(getMacUpdateInstallAttemptPath(appDataPath), attempt)

    expect(
      resolveMacUpdateInstallStartup({
        appDataPath,
        appVersion: attempt.sourceVersion,
        executablePath: EXECUTABLE_PATH,
        isPackaged: true,
        platform: 'darwin',
        nowMs: 20_001,
        readProcessStartedAtMs: () => attempt.monitorStartedAtMs + 1_000,
        readProcessList: () => ''
      })
    ).toEqual({
      action: 'allow-with-failure',
      reason: 'install-abandoned',
      failureReason: 'monitor-exited'
    })
  })

  it('rejects persisted values whose runtime types do not match the attempt schema', () => {
    const appDataPath = mkdtempSync(join(tmpdir(), 'orca-update-attempt-'))
    tempDirectories.push(appDataPath)
    const attemptPath = getMacUpdateInstallAttemptPath(appDataPath)
    writeMacUpdateInstallAttempt(attemptPath, {
      ...createAttempt(),
      targetVersion: ['1.4.192']
    } as unknown as MacUpdateInstallAttempt)

    expect(readMacUpdateInstallAttempt(attemptPath)).toBeNull()
  })
})
