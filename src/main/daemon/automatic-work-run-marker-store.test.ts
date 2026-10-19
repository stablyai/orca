import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AutomaticWorkRunMarker,
  automaticWorkMarkerPathFor
} from './automatic-work-run-marker-store'

const BOOT = { bootTimeMs: 1_000_000, bootId: null }

describe('AutomaticWorkRunMarker', () => {
  let dir: string
  let path: string
  const logger = { log: vi.fn() }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-automatic-work-'))
    path = join(dir, 'automatic-work-run.json')
    logger.log.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function open(now = 10, boot = BOOT): AutomaticWorkRunMarker {
    const marker = new AutomaticWorkRunMarker(path, logger)
    marker.open(now, boot)
    return marker
  }

  it('pauses after the previous daemon died with automatic work running in this boot', () => {
    open().arm()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'running' })

    const next = open(20)
    expect(next.mode).toEqual({ kind: 'paused', reason: 'unclean_host_death', since: 20 })
    expect(logger.log).toHaveBeenCalledWith(
      'automatic-work-paused',
      expect.objectContaining({ reason: 'unclean_host_death' })
    )
  })

  it('keeps a crash pause until an explicit resume, which survives the next start', () => {
    open().arm()
    const paused = open(20)
    expect(open(30).mode).toMatchObject({ kind: 'paused', reason: 'unclean_host_death' })

    const carried = open(40)
    carried.resume()
    expect(carried.mode).toEqual({ kind: 'normal' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ mode: { kind: 'normal' } })
    expect(logger.log).toHaveBeenCalledWith(
      'automatic-work-resumed',
      expect.objectContaining({ reason: 'unclean_host_death' })
    )
    carried.markCleanExit()
    expect(open(50).mode).toEqual({ kind: 'normal' })
    expect(paused.mode.kind).toBe('paused')
  })

  it('does not pause after an orderly exit, or when nothing automatic ran', () => {
    const first = open()
    first.arm()
    first.markCleanExit()
    expect(open(20).mode).toEqual({ kind: 'normal' })
    expect(open(30).mode).toEqual({ kind: 'normal' })
  })

  it('never reads an outside stop as a crash, even when the exit is then cut short', () => {
    const stopped = open()
    stopped.arm()
    stopped.recordStopRequested()
    // No markCleanExit: the teardown died (e.g. SIGBUS as the scope stop took its mount).
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'clean-exit' })
    expect(open(20).mode).toEqual({ kind: 'normal' })
  })

  it('keeps the stop on record when automatic work is armed or resumed after it', () => {
    const marker = open()
    marker.recordStopRequested()
    marker.arm()
    marker.resume()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'clean-exit' })
    expect(open(20).mode).toEqual({ kind: 'normal' })
  })

  it('keeps a recorded pause across a stop until an explicit resume', () => {
    open().arm()
    const paused = open(20)
    paused.recordStopRequested()
    expect(open(30).mode).toMatchObject({ kind: 'paused', reason: 'unclean_host_death' })
  })

  it('does not pause on a new boot', () => {
    open().arm()
    expect(open(20, { bootTimeMs: BOOT.bootTimeMs + 3_600_000, bootId: null }).mode).toEqual({
      kind: 'normal'
    })
  })

  it('arms on open when a fork was admitted before the endpoint was won', () => {
    const marker = new AutomaticWorkRunMarker(path, logger)
    marker.arm()
    marker.open(10, BOOT)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'running' })
  })

  it('stays inert without a path and before open', () => {
    const inert = new AutomaticWorkRunMarker(undefined, logger)
    inert.open(10, BOOT)
    inert.arm()
    inert.markCleanExit()
    expect(inert.mode).toEqual({ kind: 'normal' })

    const unopened = new AutomaticWorkRunMarker(path, logger)
    unopened.markCleanExit()
    expect(() => readFileSync(path)).toThrow()
  })

  it('never writes once the daemon has lost its endpoint to a successor', () => {
    let owns = true
    const marker = new AutomaticWorkRunMarker(path, logger, () => owns)
    marker.open(10, BOOT)
    marker.arm()
    owns = false
    marker.markCleanExit()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'running' })
  })

  it('keeps one marker per protocol version beside its PID record', () => {
    expect(automaticWorkMarkerPathFor(join(dir, 'daemon-v44.pid'))).toBe(
      join(dir, 'daemon-v44.automatic-work-run.json')
    )
  })
})
