import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeHangDetectionMarker,
  hangDetectionMarkerPath,
  writeHangDetectionMarker
} from './hang-detection-marker'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync)
  }
})

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

  it.each(['stat', 'read'])('retains a real marker after a transient %s failure', (operation) => {
    const markerPath = hangDetectionMarkerPath(dir)
    const marker = { detectedAt: 1, parentPid: 2, unresponsiveMs: 45000, selfRecovered: false }
    writeHangDetectionMarker(markerPath, marker)
    const fail = (): never => {
      throw Object.assign(new Error('temporary I/O failure'), { code: 'EIO' })
    }
    if (operation === 'stat') {
      vi.mocked(statSync).mockImplementationOnce(fail)
    } else {
      vi.mocked(readFileSync).mockImplementationOnce(fail)
    }
    expect(consumeHangDetectionMarker(markerPath)).toBeNull()
    expect(existsSync(markerPath)).toBe(true)
    expect(consumeHangDetectionMarker(markerPath)).toEqual(marker)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('deletes an oversized marker without reading its contents', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeFileSync(markerPath, 'x'.repeat(64 * 1024 + 1))
    vi.mocked(readFileSync).mockClear()
    expect(consumeHangDetectionMarker(markerPath)).toBeNull()
    expect(readFileSync).not.toHaveBeenCalled()
    expect(existsSync(markerPath)).toBe(false)
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
