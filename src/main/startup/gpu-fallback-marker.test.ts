import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GPU_FALLBACK_MARKER_FILE,
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

  it('persists explicit safe-graphics consent across launches', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 123, crashesInWindow: 3, userConfirmed: true },
      win32Environment
    )
    expect(readActiveGpuFallbackMarker(userDataPath, win32Environment)?.userConfirmed).toBe(true)
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

  // A macOS fallback marker would skip the Graphite fix inside GPU-feature setup; ensure fallback stays win32|linux only.
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
})
