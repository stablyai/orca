import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getMacUpdateInstallAttemptPath,
  readMacUpdateInstallAttempt,
  writeMacUpdateInstallAttempt,
  type MacUpdateInstallAttempt
} from './mac-update-install-attempt'
import {
  decideMacUpdateMonitorStep,
  runMacUpdateInstallMonitor
} from './mac-update-install-monitor'

const tempDirectories: string[] = []

function createAttempt(appDataPath: string): { attempt: MacUpdateInstallAttempt; path: string } {
  const attempt: MacUpdateInstallAttempt = {
    schemaVersion: 1,
    attemptId: 'attempt-1',
    sourceVersion: '1.4.192-adhoc.20260828225951',
    targetVersion: '1.4.192',
    targetBundlePath: '/Applications/Orca.app',
    sourcePid: 100,
    sourceStartedAtMs: 10_000,
    monitorPid: 101,
    monitorStartedAtMs: 11_000,
    phase: 'installing',
    createdAtMs: 1_000,
    heartbeatAtMs: 1_000
  }
  const path = getMacUpdateInstallAttemptPath(appDataPath)
  writeMacUpdateInstallAttempt(path, attempt)
  return { attempt, path }
}

function createAppData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-update-monitor-'))
  tempDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('macOS update install monitor', () => {
  it('does not interpret source exit or a short ShipIt restart gap as failure', () => {
    const attempt = createAttempt(createAppData()).attempt
    expect(
      decideMacUpdateMonitorStep({
        attempt,
        observation: {
          bundleVersion: attempt.sourceVersion,
          shipIt: 'alive',
          source: 'dead'
        },
        nowMs: 2_000,
        shipItSeen: false,
        shipItMissingSinceMs: null
      })
    ).toEqual({ action: 'continue', shipItSeen: true, shipItMissingSinceMs: null })
    expect(
      decideMacUpdateMonitorStep({
        attempt,
        observation: {
          bundleVersion: attempt.sourceVersion,
          shipIt: 'absent',
          source: 'dead'
        },
        nowMs: 3_000,
        shipItSeen: true,
        shipItMissingSinceMs: null
      })
    ).toEqual({ action: 'continue', shipItSeen: true, shipItMissingSinceMs: 3_000 })
  })

  it('clears the handoff when the exact target version reaches the bundle', async () => {
    const { attempt, path } = createAttempt(createAppData())
    const launchRecovery = vi.fn().mockResolvedValue(true)

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => 2_000,
        wait: async () => {},
        observe: async () => ({
          bundleVersion: attempt.targetVersion,
          shipIt: 'absent',
          source: 'dead'
        }),
        launchRecovery
      })
    ).resolves.toBe('completed')
    expect(readMacUpdateInstallAttempt(path)).toBeNull()
    expect(launchRecovery).not.toHaveBeenCalled()
  })

  it('records one failure and launches one bounded recovery after ShipIt exits', async () => {
    const { attempt, path } = createAttempt(createAppData())
    const observations = [
      { bundleVersion: attempt.sourceVersion, shipIt: 'alive' as const, source: 'dead' as const },
      { bundleVersion: attempt.sourceVersion, shipIt: 'absent' as const, source: 'dead' as const },
      { bundleVersion: attempt.sourceVersion, shipIt: 'absent' as const, source: 'dead' as const },
      // Consumed by the pre-recovery confirm probe: still gone, still the old version.
      { bundleVersion: attempt.sourceVersion, shipIt: 'absent' as const, source: 'dead' as const }
    ]
    const times = [2_000, 3_000, 9_000]
    const launchRecovery = vi.fn().mockResolvedValue(true)

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => times.shift() ?? 9_000,
        wait: async () => {},
        observe: async () => observations.shift()!,
        launchRecovery
      })
    ).resolves.toBe('failed')
    expect(readMacUpdateInstallAttempt(path)).toMatchObject({
      phase: 'failed',
      failureReason: 'installer-exited-with-source-version',
      recoveryLaunchedAtMs: 9_000
    })
    expect(launchRecovery).toHaveBeenCalledOnce()

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        wait: async () => {},
        launchRecovery
      })
    ).resolves.toBe('cancelled')
    expect(launchRecovery).toHaveBeenCalledOnce()
  })

  it('does not let a reused source pid postpone failed-installer recovery', async () => {
    const appDataPath = createAppData()
    const bundlePath = join(appDataPath, 'Orca.app')
    mkdirSync(join(bundlePath, 'Contents'), { recursive: true })
    writeFileSync(
      join(bundlePath, 'Contents', 'Info.plist'),
      '<key>CFBundleShortVersionString</key><string>1.4.192-adhoc.20260828225951</string>'
    )
    const { attempt, path } = createAttempt(appDataPath)
    writeMacUpdateInstallAttempt(path, {
      ...attempt,
      targetBundlePath: bundlePath,
      sourcePid: process.pid,
      sourceStartedAtMs: 1
    })
    // First verified source-dead observation starts the appearance window; the second
    // poll lands past that window without reaching the overall timeout.
    const times = [31_001, 61_002]
    const launchRecovery = vi.fn().mockResolvedValue(true)

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => times.shift() ?? times[0]!,
        wait: async () => {},
        launchRecovery
      })
    ).resolves.toBe('failed')
    expect(readMacUpdateInstallAttempt(path)).toMatchObject({
      failureReason: 'installer-never-started'
    })
    expect(launchRecovery).toHaveBeenCalledOnce()
  })
})
