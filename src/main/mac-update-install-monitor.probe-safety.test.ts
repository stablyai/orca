import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearMacUpdateInstallAttempt,
  getMacUpdateInstallAttemptPath,
  getMacUpdateInstallHeartbeatPath,
  readMacUpdateInstallAttempt,
  readMacUpdateInstallHeartbeat,
  writeMacUpdateInstallAttempt,
  type MacUpdateInstallAttempt
} from './mac-update-install-attempt'
import {
  decideMacUpdateMonitorStep,
  MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS,
  MAC_UPDATE_MONITOR_TIMEOUT_MS,
  runMacUpdateInstallMonitor
} from './mac-update-install-monitor'

const tempDirectories: string[] = []

function createAttempt(overrides: Partial<MacUpdateInstallAttempt> = {}): MacUpdateInstallAttempt {
  return {
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
    heartbeatAtMs: 1_000,
    ...overrides
  }
}

function createAttemptFile(): { attempt: MacUpdateInstallAttempt; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-update-monitor-probe-'))
  tempDirectories.push(directory)
  const attempt = createAttempt()
  const path = getMacUpdateInstallAttemptPath(directory)
  writeMacUpdateInstallAttempt(path, attempt)
  return { attempt, path }
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('macOS update monitor probe safety', () => {
  it('never fails the install on an unverified process list, even past every window', () => {
    const attempt = createAttempt()
    for (const nowMs of [
      attempt.createdAtMs + MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS + 1,
      attempt.createdAtMs + MAC_UPDATE_MONITOR_TIMEOUT_MS - 1
    ]) {
      expect(
        decideMacUpdateMonitorStep({
          attempt,
          observation: { bundleVersion: attempt.sourceVersion, shipIt: 'unknown', source: 'dead' },
          nowMs,
          shipItSeen: false,
          shipItMissingSinceMs: null
        }).action
      ).toBe('continue')
    }
  })

  it('freezes the exit-grace clock while the process list is unverified', () => {
    const attempt = createAttempt()
    const decision = decideMacUpdateMonitorStep({
      attempt,
      observation: { bundleVersion: attempt.sourceVersion, shipIt: 'unknown', source: 'dead' },
      nowMs: 60_000,
      shipItSeen: true,
      shipItMissingSinceMs: 3_000
    })
    expect(decision).toEqual({
      action: 'continue',
      shipItSeen: true,
      shipItMissingSinceMs: 3_000
    })
  })

  it('treats an unverifiable source as still quitting instead of failing early', () => {
    const attempt = createAttempt()
    const decision = decideMacUpdateMonitorStep({
      attempt,
      observation: {
        bundleVersion: attempt.sourceVersion,
        shipIt: 'absent',
        source: 'unverifiable'
      },
      nowMs: attempt.createdAtMs + MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS + 1,
      shipItSeen: false,
      shipItMissingSinceMs: null
    })
    expect(decision).toEqual({ action: 'continue', shipItSeen: false, shipItMissingSinceMs: null })
  })

  it('still times out a genuinely stuck install even with unverified probes', () => {
    const attempt = createAttempt()
    expect(
      decideMacUpdateMonitorStep({
        attempt,
        observation: {
          bundleVersion: attempt.sourceVersion,
          shipIt: 'unknown',
          source: 'unverifiable'
        },
        nowMs: attempt.createdAtMs + MAC_UPDATE_MONITOR_TIMEOUT_MS,
        shipItSeen: false,
        shipItMissingSinceMs: null
      })
    ).toEqual({ action: 'fail', reason: 'install-timed-out' })
  })

  it('measures the installer-appearance window from first verified source death', () => {
    const attempt = createAttempt()
    const wedgedQuitReleaseMs = attempt.createdAtMs + 25_000
    // 29s after arm but only 4s after the source verifiably died: not a failure yet.
    expect(
      decideMacUpdateMonitorStep({
        attempt,
        observation: { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' },
        nowMs: attempt.createdAtMs + 29_000,
        shipItSeen: false,
        shipItMissingSinceMs: null,
        sourceDeadSinceMs: wedgedQuitReleaseMs
      }).action
    ).toBe('continue')
    // The full window after source death has elapsed: now it is a failure.
    expect(
      decideMacUpdateMonitorStep({
        attempt,
        observation: { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' },
        nowMs: wedgedQuitReleaseMs + MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS,
        shipItSeen: false,
        shipItMissingSinceMs: null,
        sourceDeadSinceMs: wedgedQuitReleaseMs
      })
    ).toEqual({ action: 'fail', reason: 'installer-never-started' })
  })

  it('cancels a failure when the confirm probe finds ShipIt alive again', async () => {
    const { attempt, path } = createAttemptFile()
    const launchRecovery = vi.fn().mockResolvedValue(true)
    let calls = 0

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => attempt.createdAtMs + MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS + 1,
        wait: async () => {},
        observe: async () => {
          calls += 1
          // 1: verified absent, source dead -> fail decision. 2: confirm probe sees ShipIt
          // alive -> failure cancelled. 3: install completes.
          if (calls === 1) {
            return { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' }
          }
          if (calls === 2) {
            return { bundleVersion: attempt.sourceVersion, shipIt: 'alive', source: 'dead' }
          }
          return { bundleVersion: attempt.targetVersion, shipIt: 'absent', source: 'dead' }
        },
        launchRecovery
      })
    ).resolves.toBe('completed')
    expect(launchRecovery).not.toHaveBeenCalled()
    expect(readMacUpdateInstallAttempt(path)).toBeNull()
  })

  it('keeps polling when the confirm probe cannot verify ShipIt, without marking it seen', async () => {
    const { attempt, path } = createAttemptFile()
    const launchRecovery = vi.fn().mockResolvedValue(true)
    const t0 = attempt.createdAtMs
    // Poll 1 starts the appearance window at first verified source death; polls 2 and 3 are
    // past it. Each failing poll consumes one extra observation for its confirm probe.
    const times = [t0 + 2_000, t0 + 33_000, t0 + 35_000]
    const observations: {
      bundleVersion: string
      shipIt: 'alive' | 'absent' | 'unknown'
      source: 'dead'
    }[] = [
      { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' },
      { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' },
      // Confirm probe: ps hiccup. Must neither fail nor count as ShipIt having been seen.
      { bundleVersion: attempt.sourceVersion, shipIt: 'unknown', source: 'dead' },
      { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' },
      { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' }
    ]
    const observe = vi.fn(async () => observations.shift()!)

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => times.shift() ?? t0 + 35_000,
        wait: async () => {},
        observe,
        launchRecovery
      })
    ).resolves.toBe('failed')
    expect(observe).toHaveBeenCalledTimes(5)
    expect(launchRecovery).toHaveBeenCalledOnce()
    // Why never-started: an unknown confirm must not flip shipItSeen and reword the failure.
    expect(readMacUpdateInstallAttempt(path)).toMatchObject({
      phase: 'failed',
      failureReason: 'installer-never-started'
    })
  })

  it('completes instead of failing when the confirm probe sees the target version', async () => {
    const { attempt, path } = createAttemptFile()
    const launchRecovery = vi.fn().mockResolvedValue(true)
    let calls = 0

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => attempt.createdAtMs + MAC_UPDATE_MONITOR_TIMEOUT_MS,
        wait: async () => {},
        observe: async () => {
          calls += 1
          return calls === 1
            ? { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' }
            : { bundleVersion: attempt.targetVersion, shipIt: 'absent', source: 'dead' }
        },
        launchRecovery
      })
    ).resolves.toBe('completed')
    expect(launchRecovery).not.toHaveBeenCalled()
  })

  it('does not resurrect an attempt cleared mid-observation via the heartbeat write', async () => {
    const { attempt, path } = createAttemptFile()
    let observations = 0

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => 2_000,
        wait: async () => {},
        observe: async () => {
          observations += 1
          if (observations === 1) {
            // Startup cleanup clears the attempt while this observation is in flight.
            clearMacUpdateInstallAttempt(path, attempt.attemptId)
          }
          return { bundleVersion: attempt.sourceVersion, shipIt: 'alive', source: 'alive' }
        },
        launchRecovery: vi.fn().mockResolvedValue(true)
      })
    ).resolves.toBe('cancelled')
    expect(readMacUpdateInstallAttempt(path)).toBeNull()
    expect(existsSync(getMacUpdateInstallHeartbeatPath(path))).toBe(false)
  })

  it('cancels instead of writing a failure when cleanup cleared the attempt mid-step', async () => {
    const { attempt, path } = createAttemptFile()
    const launchRecovery = vi.fn().mockResolvedValue(true)

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => attempt.createdAtMs + MAC_UPDATE_MONITOR_TIMEOUT_MS,
        wait: async () => {},
        observe: async () => {
          clearMacUpdateInstallAttempt(path, attempt.attemptId)
          return { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' }
        },
        launchRecovery
      })
    ).resolves.toBe('cancelled')
    expect(readMacUpdateInstallAttempt(path)).toBeNull()
    expect(launchRecovery).not.toHaveBeenCalled()
  })

  it('cancels without clobbering a replacement attempt from a newer install', async () => {
    const { attempt, path } = createAttemptFile()
    const replacement = createAttempt({ attemptId: 'attempt-2', targetVersion: '1.4.193' })

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => attempt.createdAtMs + MAC_UPDATE_MONITOR_TIMEOUT_MS,
        wait: async () => {},
        observe: async () => {
          writeMacUpdateInstallAttempt(path, replacement)
          return { bundleVersion: attempt.sourceVersion, shipIt: 'absent', source: 'dead' }
        },
        launchRecovery: vi.fn().mockResolvedValue(true)
      })
    ).resolves.toBe('cancelled')
    expect(readMacUpdateInstallAttempt(path)).toMatchObject({
      attemptId: 'attempt-2',
      phase: 'installing',
      targetVersion: '1.4.193'
    })
  })

  it('writes its liveness to the sibling heartbeat file, not the attempt record', async () => {
    const { attempt, path } = createAttemptFile()
    let steps = 0
    let midRunHeartbeatAtMs: number | null = null
    let midRunRecordHeartbeatAtMs: number | null = null

    await expect(
      runMacUpdateInstallMonitor({
        attemptPath: path,
        attemptId: attempt.attemptId,
        now: () => 5_000,
        wait: async () => {},
        observe: async () => {
          steps += 1
          if (steps === 2) {
            midRunHeartbeatAtMs = readMacUpdateInstallHeartbeat(path)?.heartbeatAtMs ?? null
            midRunRecordHeartbeatAtMs = readMacUpdateInstallAttempt(path)?.heartbeatAtMs ?? null
          }
          return steps === 1
            ? { bundleVersion: attempt.sourceVersion, shipIt: 'alive', source: 'alive' }
            : { bundleVersion: attempt.targetVersion, shipIt: 'absent', source: 'dead' }
        }
      })
    ).resolves.toBe('completed')
    expect(midRunHeartbeatAtMs).toBe(5_000)
    // The attempt record's own heartbeat field stays at its armed value.
    expect(midRunRecordHeartbeatAtMs).toBe(attempt.heartbeatAtMs)
    expect(readMacUpdateInstallAttempt(path)).toBeNull()
    expect(readMacUpdateInstallHeartbeat(path)).toBeNull()
  })
})
