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
})
