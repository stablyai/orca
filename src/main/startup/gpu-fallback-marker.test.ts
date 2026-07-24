import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GPU_FALLBACK_MARKER_FILE,
  MAX_GPU_FALLBACK_MARKER_FILE_BYTES,
  clearGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  readGpuFallbackMarker,
  writeGpuFallbackMarker
} from './gpu-fallback-marker'

describe('gpu-fallback-marker', () => {
  let userDataPath: string
  const environment = {
    appVersion: '1.2.3',
    electronVersion: '42.3.3',
    platform: 'win32' as const
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-fallback-test-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('round-trips a written marker', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 123, crashesInWindow: 3 }, environment)
    expect(readGpuFallbackMarker(userDataPath)).toEqual({
      schemeVersion: 2,
      engagedAt: 123,
      crashesInWindow: 3,
      appVersion: '1.2.3',
      electronVersion: '42.3.3',
      platform: 'win32'
    })
  })

  it('returns null when no marker exists', () => {
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
  })

  it('keeps an active marker for repeated launches on the same build', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const firstRead = readActiveGpuFallbackMarker(userDataPath, environment)
    expect(firstRead?.crashesInWindow).toBe(4)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const secondRead = readActiveGpuFallbackMarker(userDataPath, environment)
    expect(secondRead?.crashesInWindow).toBe(4)
  })

  it('clears an active marker when the app build changes', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...environment,
        appVersion: '1.2.4'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears an active marker outside Windows', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...environment,
        platform: 'linux'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears a corrupt or wrong-version marker', () => {
    writeFileSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE), '{ not json')
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)

    writeFileSync(
      join(userDataPath, GPU_FALLBACK_MARKER_FILE),
      JSON.stringify({ schemeVersion: 999, engagedAt: 1, crashesInWindow: 1 })
    )
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('can explicitly clear the marker', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)
    clearGpuFallbackMarker(userDataPath)
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
  })

  it('clears an oversized sparse marker without loading it', () => {
    const path = join(userDataPath, GPU_FALLBACK_MARKER_FILE)
    writeFileSync(path, '{"schemeVersion":2}')
    truncateSync(path, MAX_GPU_FALLBACK_MARKER_FILE_BYTES + 1)

    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })
})
