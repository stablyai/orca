import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeHangDetectionMarker } from './hang-detection-marker'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ unref: vi.fn() }))
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

import {
  isHangWatchdogWorkerData,
  recordHangObservation,
  runWatchdog
} from './main-thread-hang-watchdog-entry'
import { createHangWatchdogSpanTracker } from './hang-watchdog-active-spans'

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

  it('records an unresolved hang', () => {
    const markerPath = join(dir, 'marker.json')
    recordHangObservation({
      parentPid: 4242,
      markerPath,
      unresponsiveMs: 47_000,
      selfRecovered: false
    })
    expect(consumeHangDetectionMarker(markerPath)).toMatchObject({
      parentPid: 4242,
      unresponsiveMs: 47_000,
      selfRecovered: false
    })
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
    // Why: a false positive must never kill a live main thread while writes may be in flight.
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

  it('survives an unwritable marker path', () => {
    expect(() =>
      recordHangObservation({
        parentPid: 4242,
        markerPath: join(dir, 'missing-subdir', 'marker.json'),
        unresponsiveMs: 45_000,
        selfRecovered: false
      })
    ).not.toThrow()
  })

  it('is a no-op when no marker path is configured', () => {
    expect(() =>
      recordHangObservation({
        parentPid: 4242,
        markerPath: '',
        unresponsiveMs: 45_000,
        selfRecovered: false
      })
    ).not.toThrow()
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

  it('accepts only complete positive worker data', () => {
    expect(
      isHangWatchdogWorkerData({
        parentPid: 42,
        markerPath: '/tmp/marker',
        timeoutMs: 100,
        checkIntervalMs: 25
      })
    ).toBe(true)
    for (const value of [
      null,
      {},
      { parentPid: 0, markerPath: '/tmp/marker', timeoutMs: 100, checkIntervalMs: 25 },
      { parentPid: 42, markerPath: 7, timeoutMs: 100, checkIntervalMs: 25 },
      { parentPid: 42, markerPath: '/tmp/marker', timeoutMs: 0, checkIntervalMs: 25 },
      { parentPid: 42, markerPath: '/tmp/marker', timeoutMs: 100, checkIntervalMs: Infinity }
    ]) {
      expect(isHangWatchdogWorkerData(value)).toBe(false)
    }
  })

  it('routes heartbeats and shuts down its timer and port', () => {
    const markerPath = join(tmpdir(), `hang-watchdog-entry-${process.pid}.json`)
    const tracker = createHangWatchdogSpanTracker()
    tracker.observer.started('operation', 'git.exec', 0)
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
          activeSpanBuffer: tracker.buffer,
          timeoutMs: 100,
          checkIntervalMs: 25
        },
        port
      )
      vi.advanceTimersByTime(75)
      onMessage?.({ type: 'heartbeat' })
      vi.advanceTimersByTime(75)
      expect(consumeHangDetectionMarker(markerPath)).toBeNull()
      vi.advanceTimersByTime(50)
      const detected = consumeHangDetectionMarker(markerPath)
      expect(detected).toMatchObject({
        selfRecovered: false,
        inFlightSpans: [{ name: 'git.exec', elapsedMs: 200 }]
      })

      tracker.observer.ended('operation')
      onMessage?.({ type: 'heartbeat' })
      expect(consumeHangDetectionMarker(markerPath)).toMatchObject({
        selfRecovered: true,
        detectedAt: detected?.detectedAt,
        inFlightSpans: detected?.inFlightSpans
      })
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
