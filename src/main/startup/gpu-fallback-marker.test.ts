import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GPU_FALLBACK_MARKER_FILE,
  clearGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  readGpuFallbackMarker,
  writeGpuFallbackMarker
} from './gpu-fallback-marker'

describe('gpu-fallback-marker', () => {
  let userDataPath: string
  const win32Environment = {
    appVersion: '1.2.3',
    electronVersion: '42.3.3',
    platform: 'win32' as const
  }
  const linuxEnvironment = {
    appVersion: '1.2.3',
    electronVersion: '42.3.3',
    platform: 'linux' as const
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-fallback-test-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('round-trips a written Windows marker', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 123, crashesInWindow: 3, userConfirmed: false },
      win32Environment
    )
    expect(readGpuFallbackMarker(userDataPath)).toEqual({
      schemeVersion: 3,
      engagedAt: 123,
      crashesInWindow: 3,
      userConfirmed: false,
      appVersion: '1.2.3',
      electronVersion: '42.3.3',
      platform: 'win32'
    })
  })

  it('round-trips a written Linux marker', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 456, crashesInWindow: 5, userConfirmed: false },
      linuxEnvironment
    )
    expect(readGpuFallbackMarker(userDataPath)).toEqual({
      schemeVersion: 3,
      engagedAt: 456,
      crashesInWindow: 5,
      userConfirmed: false,
      appVersion: '1.2.3',
      electronVersion: '42.3.3',
      platform: 'linux'
    })
  })

  it('persists explicit safe-graphics consent across launches', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 123, crashesInWindow: 3, userConfirmed: true },
      win32Environment
    )
    expect(readActiveGpuFallbackMarker(userDataPath, win32Environment)?.userConfirmed).toBe(true)
  })

  it('returns null when no marker exists', () => {
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, win32Environment)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, linuxEnvironment)).toBeNull()
  })

  it('keeps an active marker for repeated launches on the same build (Windows)', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 4, userConfirmed: false },
      win32Environment
    )
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const firstRead = readActiveGpuFallbackMarker(userDataPath, win32Environment)
    expect(firstRead?.crashesInWindow).toBe(4)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const secondRead = readActiveGpuFallbackMarker(userDataPath, win32Environment)
    expect(secondRead?.crashesInWindow).toBe(4)
  })

  it('keeps an active marker for repeated launches on the same build (Linux)', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 4, userConfirmed: false },
      linuxEnvironment
    )
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const firstRead = readActiveGpuFallbackMarker(userDataPath, linuxEnvironment)
    expect(firstRead?.crashesInWindow).toBe(4)

    const secondRead = readActiveGpuFallbackMarker(userDataPath, linuxEnvironment)
    expect(secondRead?.crashesInWindow).toBe(4)
  })

  it('clears an active marker when the app build changes', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 4, userConfirmed: false },
      win32Environment
    )

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...win32Environment,
        appVersion: '1.2.4'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears a Linux marker when the app build changes', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 4, userConfirmed: false },
      linuxEnvironment
    )

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...linuxEnvironment,
        appVersion: '1.2.4'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears a marker when the platform changes between supported platforms', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 4, userConfirmed: false },
      win32Environment
    )

    expect(readActiveGpuFallbackMarker(userDataPath, linuxEnvironment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  // Why: enableMainProcessGpuFeatures() is skipped while GPU fallback is active, and that function
  // carries the macOS disable-skia-graphite fix. A marker that survived on darwin would silently
  // strip the fix from the Macs it targets, so pin the platform gate for darwin specifically.
  it('clears an active marker on macOS so the Graphite fix is never skipped', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 4, userConfirmed: false },
      win32Environment
    )

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...win32Environment,
        platform: 'darwin'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears a corrupt or wrong-version marker', () => {
    writeFileSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE), '{ not json')
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, win32Environment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)

    writeFileSync(
      join(userDataPath, GPU_FALLBACK_MARKER_FILE),
      JSON.stringify({ schemeVersion: 999, engagedAt: 1, crashesInWindow: 1 })
    )
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, win32Environment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('rejects a marker with an unsupported platform value', () => {
    writeFileSync(
      join(userDataPath, GPU_FALLBACK_MARKER_FILE),
      JSON.stringify({
        schemeVersion: 3,
        engagedAt: 1,
        crashesInWindow: 3,
        userConfirmed: false,
        appVersion: '1.2.3',
        electronVersion: '42.3.3',
        platform: 'darwin'
      })
    )
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
  })

  it('can explicitly clear the marker', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 4, userConfirmed: false },
      win32Environment
    )
    clearGpuFallbackMarker(userDataPath)
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
  })
})
