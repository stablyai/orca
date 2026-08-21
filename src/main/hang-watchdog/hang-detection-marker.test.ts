import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  consumeHangDetectionMarker,
  hangDetectionMarkerPath,
  writeHangDetectionMarker
} from './hang-detection-marker'

describe('hang detection marker', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hang-marker-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a marker and deletes it on consume', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeHangDetectionMarker(markerPath, {
      detectedAt: 123,
      parentPid: 456,
      unresponsiveMs: 45000,
      selfRecovered: false
    })
    expect(consumeHangDetectionMarker(markerPath)).toEqual({
      detectedAt: 123,
      parentPid: 456,
      unresponsiveMs: 45000,
      selfRecovered: false
    })
    expect(existsSync(markerPath)).toBe(false)
    expect(consumeHangDetectionMarker(markerPath)).toBeNull()
  })

  it('round-trips a self-recovered marker', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeHangDetectionMarker(markerPath, {
      detectedAt: 1,
      parentPid: 2,
      unresponsiveMs: 61000,
      selfRecovered: true
    })
    expect(consumeHangDetectionMarker(markerPath)?.selfRecovered).toBe(true)
  })

  it('returns null for a missing marker', () => {
    expect(consumeHangDetectionMarker(hangDetectionMarkerPath(dir))).toBeNull()
  })

  // Why: a marker written by the detect leg has no selfRecovered field until the resolve leg
  // rewrites it, and "never resolved" is the conservative reading of its absence.
  it('treats a missing selfRecovered flag as an unresolved hang', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeFileSync(
      markerPath,
      JSON.stringify({ detectedAt: 1, parentPid: 2, unresponsiveMs: 45000 })
    )
    expect(consumeHangDetectionMarker(markerPath)?.selfRecovered).toBe(false)
  })

  it('returns null for corrupted or incomplete markers and still deletes them', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeFileSync(markerPath, 'not json')
    expect(consumeHangDetectionMarker(markerPath)).toBeNull()
    expect(existsSync(markerPath)).toBe(false)

    writeFileSync(markerPath, JSON.stringify({ detectedAt: 1 }))
    expect(consumeHangDetectionMarker(markerPath)).toBeNull()
    expect(existsSync(markerPath)).toBe(false)
  })
})
