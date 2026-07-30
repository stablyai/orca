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

import { recordHangObservation } from './main-thread-hang-watchdog-entry'

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

  // Why: this is the safety contract of the whole PR. Observing a hang must never kill, relaunch,
  // or exit — a false positive would SIGKILL a live main thread mid-write. If a future change
  // reintroduces recovery, this test must fail loudly rather than ship silently.
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
