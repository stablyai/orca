import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeHangDetectionMarker } from './hang-detection-marker'
import {
  BLOCKED_FILE_WRITE_SAMPLE,
  SCENE_SELF_DEADLOCK_SAMPLE
} from './appkit-scene-self-deadlock.test-fixture'

const { spawnMock, runProcessMock, spawnDetachedMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ unref: vi.fn() })),
  runProcessMock: vi.fn(),
  spawnDetachedMock: vi.fn(() => ({ unref: vi.fn() }))
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('@orca/process-host/isolated-detached-spawn', () => ({
  spawnDetachedWithoutInheritance: spawnDetachedMock
}))

import { recordHangObservation, runWatchdog } from './main-thread-hang-watchdog-entry'

describe('recordHangObservation', () => {
  let dir: string
  let killSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hang-detect-'))
    spawnMock.mockClear()
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    killSpy.mockRestore()
    exitSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('overwrites the marker when the stall clears, keeping one observation per stall', () => {
    const markerPath = join(dir, 'marker.json')
    recordHangObservation({
      parentPid: 4242,
      markerPath,
      unresponsiveMs: 47_000,
      selfRecovered: false
    })
    recordHangObservation({
      parentPid: 4242,
      markerPath,
      unresponsiveMs: 62_000,
      selfRecovered: true
    })
    expect(consumeHangDetectionMarker(markerPath)).toMatchObject({
      unresponsiveMs: 62_000,
      selfRecovered: true
    })
  })

  it('never spawns, signals, or exits', () => {
    recordHangObservation({
      parentPid: 4242,
      markerPath: join(dir, 'marker.json'),
      unresponsiveMs: 45_000,
      selfRecovered: false
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

describe('watchdog worker entry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('routes heartbeats and shuts down its timer and port', () => {
    const markerPath = join(tmpdir(), `hang-watchdog-entry-${process.pid}.json`)
    let onMessage: ((message: { type: 'heartbeat' | 'shutdown' }) => void) | undefined
    const port = {
      on: vi.fn(
        (_event: 'message', listener: (message: { type: 'heartbeat' | 'shutdown' }) => void) => {
          onMessage = listener
        }
      ),
      close: vi.fn()
    }
    try {
      runWatchdog(
        {
          parentPid: process.pid,
          markerPath,
          timeoutMs: 100,
          checkIntervalMs: 25,
          relaunchBundlePath: null
        },
        port
      )
      vi.advanceTimersByTime(75)
      onMessage?.({ type: 'heartbeat' })
      vi.advanceTimersByTime(75)
      expect(consumeHangDetectionMarker(markerPath)).toBeNull()
      vi.advanceTimersByTime(50)
      expect(consumeHangDetectionMarker(markerPath)).toMatchObject({ selfRecovered: false })

      onMessage?.({ type: 'heartbeat' })
      expect(consumeHangDetectionMarker(markerPath)).toMatchObject({ selfRecovered: true })
      onMessage?.({ type: 'shutdown' })
      expect(port.close).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(1_000)
      expect(port.close).toHaveBeenCalledOnce()
      expect(consumeHangDetectionMarker(markerPath)).toBeNull()
    } finally {
      rmSync(markerPath, { force: true })
    }
  })
})

describe('watchdog scene-deadlock relaunch', () => {
  const parentPid = 4242
  const bundlePath = '/Applications/Orca.app'
  let markerPath: string
  let onMessage: ((message: { type: 'heartbeat' | 'shutdown' }) => void) | undefined
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    markerPath = join(mkdtempSync(join(tmpdir(), 'hang-relaunch-')), 'marker.json')
    spawnDetachedMock.mockClear()
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    runWatchdog(
      {
        parentPid,
        markerPath,
        timeoutMs: 100,
        checkIntervalMs: 25,
        relaunchBundlePath: bundlePath
      },
      {
        on: (_event, listener) => {
          onMessage = listener
        },
        close: vi.fn()
      }
    )
  })

  afterEach(() => {
    onMessage?.({ type: 'shutdown' })
    killSpy.mockRestore()
    vi.useRealTimers()
    rmSync(join(markerPath, '..'), { recursive: true, force: true })
  })

  function sampleReturns(report: string): void {
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: report,
      stderr: '',
      timedOut: false
    })
  }

  it('relaunches the bundle and kills the parent after two samples confirm the deadlock', async () => {
    sampleReturns(SCENE_SELF_DEADLOCK_SAMPLE)
    await vi.advanceTimersByTimeAsync(150)
    expect(killSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(spawnDetachedMock).toHaveBeenCalledWith({
      program: '/bin/sh',
      args: expect.arrayContaining(['4242', '/Applications/Orca.app'])
    })
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
    expect(consumeHangDetectionMarker(markerPath)).toMatchObject({
      selfRecovered: false,
      relaunched: true
    })
  })

  it('does not kill a main thread stalled on I/O', async () => {
    sampleReturns(BLOCKED_FILE_WRITE_SAMPLE)
    await vi.advanceTimersByTimeAsync(20_000)

    expect(spawnDetachedMock).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    const marker = consumeHangDetectionMarker(markerPath)
    expect(marker).toMatchObject({ parentPid: 4242, selfRecovered: false })
    expect(marker).not.toHaveProperty('relaunched')
  })

  it('does not kill when heartbeats resume before the second sample', async () => {
    sampleReturns(SCENE_SELF_DEADLOCK_SAMPLE)
    await vi.advanceTimersByTimeAsync(150)
    for (let elapsed = 0; elapsed < 10_000; elapsed += 50) {
      onMessage?.({ type: 'heartbeat' })
      await vi.advanceTimersByTimeAsync(50)
    }

    expect(spawnDetachedMock).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    expect(consumeHangDetectionMarker(markerPath)).toMatchObject({ selfRecovered: true })
  })
})
