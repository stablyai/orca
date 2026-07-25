import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RENDERER_SANDBOX_FALLBACK_MARKER_FILE,
  clearRendererSandboxFallbackMarker,
  readActiveRendererSandboxFallbackMarker,
  readRendererSandboxFallbackMarker,
  writeRendererSandboxFallbackMarker
} from './renderer-sandbox-fallback-marker'

describe('renderer-sandbox-fallback-marker', () => {
  let userDataPath: string
  const environment = {
    appVersion: '1.4.150',
    electronVersion: '43.1.0',
    platform: 'win32' as const
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-renderer-sandbox-fallback-test-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('round-trips a written marker', () => {
    writeRendererSandboxFallbackMarker(
      userDataPath,
      { engagedAt: 123, crashesInWindow: 3, exitCode: -2147483645 },
      environment
    )
    expect(readRendererSandboxFallbackMarker(userDataPath)).toEqual({
      schemeVersion: 1,
      engagedAt: 123,
      crashesInWindow: 3,
      exitCode: -2147483645,
      appVersion: '1.4.150',
      electronVersion: '43.1.0',
      platform: 'win32'
    })
  })

  it('returns null when no marker exists', () => {
    expect(readRendererSandboxFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveRendererSandboxFallbackMarker(userDataPath, environment)).toBeNull()
  })

  it('keeps an active marker for repeated launches on the same build', () => {
    writeRendererSandboxFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 3, exitCode: -2147483645 },
      environment
    )
    expect(existsSync(join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE))).toBe(true)

    expect(
      readActiveRendererSandboxFallbackMarker(userDataPath, environment)?.crashesInWindow
    ).toBe(3)
    expect(existsSync(join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE))).toBe(true)
    expect(readActiveRendererSandboxFallbackMarker(userDataPath, environment)?.exitCode).toBe(
      -2147483645
    )
  })

  it('clears an active marker when the app or Electron build changes', () => {
    writeRendererSandboxFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 3, exitCode: -2147483645 },
      environment
    )
    expect(
      readActiveRendererSandboxFallbackMarker(userDataPath, {
        ...environment,
        appVersion: '1.4.151'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE))).toBe(false)

    writeRendererSandboxFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 3, exitCode: -2147483645 },
      environment
    )
    expect(
      readActiveRendererSandboxFallbackMarker(userDataPath, {
        ...environment,
        electronVersion: '44.0.0'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears an active marker outside Windows', () => {
    writeRendererSandboxFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 3, exitCode: -2147483645 },
      environment
    )
    expect(
      readActiveRendererSandboxFallbackMarker(userDataPath, { ...environment, platform: 'linux' })
    ).toBeNull()
    expect(existsSync(join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears a corrupt or wrong-version marker', () => {
    writeFileSync(join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE), '{ not json')
    expect(readRendererSandboxFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveRendererSandboxFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE))).toBe(false)

    writeFileSync(
      join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE),
      JSON.stringify({ schemeVersion: 999, engagedAt: 1, crashesInWindow: 1, exitCode: -1 })
    )
    expect(readRendererSandboxFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveRendererSandboxFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('rejects a marker missing the exitCode field', () => {
    writeFileSync(
      join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE),
      JSON.stringify({
        schemeVersion: 1,
        engagedAt: 1,
        crashesInWindow: 3,
        appVersion: '1.4.150',
        electronVersion: '43.1.0',
        platform: 'win32'
      })
    )
    expect(readRendererSandboxFallbackMarker(userDataPath)).toBeNull()
  })

  it('can explicitly clear the marker', () => {
    writeRendererSandboxFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 3, exitCode: -2147483645 },
      environment
    )
    clearRendererSandboxFallbackMarker(userDataPath)
    expect(readRendererSandboxFallbackMarker(userDataPath)).toBeNull()
  })
})
