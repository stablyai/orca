import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearGpuCrashHistory,
  GPU_CRASH_HISTORY_FILE,
  GPU_CRASH_HISTORY_MAX_ENTRIES,
  openGpuCrashHistoryLaunch,
  readGpuCrashHistory
} from './gpu-crash-history-store'
import type { GpuFallbackEnvironment } from './gpu-fallback-marker'

const environment: GpuFallbackEnvironment = {
  appVersion: '1.4.167',
  electronVersion: '38.2.0',
  platform: 'win32'
}

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'gpu-crash-history-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('openGpuCrashHistoryLaunch', () => {
  it('bumps the launch counter on every launch, crash or not', () => {
    expect(openGpuCrashHistoryLaunch(userDataPath, environment).launchSeq).toBe(1)
    expect(openGpuCrashHistoryLaunch(userDataPath, environment).launchSeq).toBe(2)
    expect(openGpuCrashHistoryLaunch(userDataPath, environment).launchSeq).toBe(3)
  })

  it('persists crashes across launches with wall-clock timestamps', () => {
    const first = openGpuCrashHistoryLaunch(userDataPath, environment)
    first.append({ ts: 1_770_000_000_000, exitCode: 3_000 })
    const second = openGpuCrashHistoryLaunch(userDataPath, environment)
    expect(second.append({ ts: 1_770_000_090_000, exitCode: 3_000 })).toEqual([
      { ts: 1_770_000_000_000, exitCode: 3_000, launchSeq: 1 },
      { ts: 1_770_000_090_000, exitCode: 3_000, launchSeq: 2 }
    ])
  })

  it('starts over after an app update so a fixed build gets a fresh hardware attempt', () => {
    const before = openGpuCrashHistoryLaunch(userDataPath, environment)
    before.append({ ts: 1_770_000_000_000, exitCode: 3_000 })
    const upgraded = openGpuCrashHistoryLaunch(userDataPath, {
      ...environment,
      appVersion: '1.4.168'
    })
    expect(upgraded.launchSeq).toBe(1)
    expect(upgraded.append({ ts: 1_770_000_100_000, exitCode: null })).toEqual([
      { ts: 1_770_000_100_000, exitCode: null, launchSeq: 1 }
    ])
  })

  it('bounds the ring', () => {
    const launch = openGpuCrashHistoryLaunch(userDataPath, environment)
    let entries: readonly { ts: number }[] = []
    for (let index = 0; index < GPU_CRASH_HISTORY_MAX_ENTRIES + 5; index += 1) {
      entries = launch.append({ ts: 1_770_000_000_000 + index, exitCode: 3_000 })
    }
    expect(entries).toHaveLength(GPU_CRASH_HISTORY_MAX_ENTRIES)
    expect(entries[0]?.ts).toBe(1_770_000_000_000 + 5)
  })

  it('survives a corrupt file', () => {
    writeFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), '{not json')
    const launch = openGpuCrashHistoryLaunch(userDataPath, environment)
    expect(launch.launchSeq).toBe(1)
    expect(readGpuCrashHistory(userDataPath, environment)?.entries).toEqual([])
  })

  it('drops malformed entries but keeps valid ones', () => {
    writeFileSync(
      join(userDataPath, GPU_CRASH_HISTORY_FILE),
      JSON.stringify({
        schemeVersion: 1,
        appVersion: environment.appVersion,
        electronVersion: environment.electronVersion,
        platform: environment.platform,
        launchSeq: 4,
        entries: [
          { ts: 'nope', exitCode: 1, launchSeq: 1 },
          { ts: 1_770_000_000_000, exitCode: null, launchSeq: 4 }
        ]
      })
    )
    expect(readGpuCrashHistory(userDataPath, environment)?.entries).toEqual([
      { ts: 1_770_000_000_000, exitCode: null, launchSeq: 4 }
    ])
    expect(openGpuCrashHistoryLaunch(userDataPath, environment).launchSeq).toBe(5)
  })

  it('remembers a declined restart across launches without losing crashes', () => {
    const first = openGpuCrashHistoryLaunch(userDataPath, environment)
    first.append({ ts: 1_770_000_000_000, exitCode: 3_000 })
    first.noteRestartDeclined(1_770_000_000_500)
    const second = openGpuCrashHistoryLaunch(userDataPath, environment)
    expect(second.declinedAt).toBe(1_770_000_000_500)
    expect(second.append({ ts: 1_770_000_090_000, exitCode: 3_000 })).toHaveLength(2)
    expect(openGpuCrashHistoryLaunch(userDataPath, environment).declinedAt).toBe(1_770_000_000_500)
  })

  it('reports no decline for a fresh or upgraded build', () => {
    expect(openGpuCrashHistoryLaunch(userDataPath, environment).declinedAt).toBeNull()
    openGpuCrashHistoryLaunch(userDataPath, environment).noteRestartDeclined(1_770_000_000_500)
    expect(
      openGpuCrashHistoryLaunch(userDataPath, { ...environment, appVersion: '1.4.168' }).declinedAt
    ).toBeNull()
  })

  it('clears the ring when fallback engages', () => {
    openGpuCrashHistoryLaunch(userDataPath, environment).append({ ts: 1, exitCode: 3_000 })
    clearGpuCrashHistory(userDataPath)
    expect(readGpuCrashHistory(userDataPath, environment)).toBeNull()
    expect(openGpuCrashHistoryLaunch(userDataPath, environment).launchSeq).toBe(1)
  })

  it('writes the ring where the marker lives', () => {
    openGpuCrashHistoryLaunch(userDataPath, environment)
    expect(
      JSON.parse(readFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), 'utf-8')).launchSeq
    ).toBe(1)
  })
})
