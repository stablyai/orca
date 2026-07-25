import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GPU_FALLBACK_REQUIRED_TIER_FILE,
  getResumeGpuFallbackTier,
  readGpuFallbackRequiredTier,
  recordGpuFallbackRequiredTier
} from './gpu-fallback-required-tier'

describe('gpu-fallback-required-tier', () => {
  let userDataPath: string
  const environment = { appVersion: '1.4.155', electronVersion: '43.1.0' }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-required-tier-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('round-trips a recorded tier', () => {
    expect(recordGpuFallbackRequiredTier(userDataPath, 2, environment, 1_000)).toBe(2)
    expect(readGpuFallbackRequiredTier(userDataPath)).toEqual({
      schemeVersion: 1,
      requiredTier: 2,
      recordedAt: 1_000,
      appVersion: '1.4.155',
      electronVersion: '43.1.0'
    })
  })

  it('reports no resume tier for a machine with no history', () => {
    expect(getResumeGpuFallbackTier(userDataPath)).toBeNull()
    expect(readGpuFallbackRequiredTier(userDataPath)).toBeNull()
  })

  // Why: this is the whole point — the marker is version-scoped, this is not.
  it('survives an app and Electron version change', () => {
    recordGpuFallbackRequiredTier(userDataPath, 2, environment, 1_000)
    expect(getResumeGpuFallbackTier(userDataPath)).toBe(2)
    expect(readGpuFallbackRequiredTier(userDataPath)?.appVersion).toBe('1.4.155')
  })

  // Why: a shallower later burst must not talk a known-bad machine back down a rung.
  it('is monotonic', () => {
    recordGpuFallbackRequiredTier(userDataPath, 2, environment, 1_000)
    expect(recordGpuFallbackRequiredTier(userDataPath, 1, environment, 2_000)).toBe(2)
    expect(readGpuFallbackRequiredTier(userDataPath)?.requiredTier).toBe(2)
    expect(readGpuFallbackRequiredTier(userDataPath)?.recordedAt).toBe(1_000)
  })

  it('raises the recorded tier when escalating', () => {
    recordGpuFallbackRequiredTier(userDataPath, 1, environment, 1_000)
    expect(recordGpuFallbackRequiredTier(userDataPath, 2, environment, 2_000)).toBe(2)
    expect(readGpuFallbackRequiredTier(userDataPath)?.requiredTier).toBe(2)
  })

  it('leaves no temp file behind', () => {
    recordGpuFallbackRequiredTier(userDataPath, 2, environment, 1_000)
    expect(existsSync(join(userDataPath, `${GPU_FALLBACK_REQUIRED_TIER_FILE}.tmp`))).toBe(false)
  })

  // Why: a hint, not an authority — bad input degrades to normal ladder escalation.
  it('degrades to no history on corrupt, off-ladder, or wrong-version records', () => {
    const file = join(userDataPath, GPU_FALLBACK_REQUIRED_TIER_FILE)

    writeFileSync(file, '{ not json')
    expect(getResumeGpuFallbackTier(userDataPath)).toBeNull()

    writeFileSync(file, JSON.stringify({ schemeVersion: 1, requiredTier: 99, recordedAt: 1 }))
    expect(getResumeGpuFallbackTier(userDataPath)).toBeNull()

    writeFileSync(file, JSON.stringify({ schemeVersion: 99, requiredTier: 2, recordedAt: 1 }))
    expect(getResumeGpuFallbackTier(userDataPath)).toBeNull()

    writeFileSync(file, JSON.stringify({ schemeVersion: 1, requiredTier: 2 }))
    expect(getResumeGpuFallbackTier(userDataPath)).toBeNull()
  })

  it('reports failure rather than throwing when the record cannot be written', () => {
    expect(
      recordGpuFallbackRequiredTier(join(userDataPath, 'missing'), 2, environment, 1_000)
    ).toBeNull()
  })
})
