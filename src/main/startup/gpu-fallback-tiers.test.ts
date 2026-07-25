import { describe, expect, it } from 'vitest'
import {
  MAX_GPU_FALLBACK_TIER,
  clampGpuFallbackTier,
  getGpuFallbackTierSwitches,
  getNextGpuFallbackTier,
  isGpuFallbackTier,
  resolveGpuFallbackEscalation
} from './gpu-fallback-tiers'

describe('gpu-fallback-tiers', () => {
  it('escalates one rung at a time and stops at the top', () => {
    expect(getNextGpuFallbackTier(0)).toBe(1)
    expect(getNextGpuFallbackTier(1)).toBe(2)
    expect(getNextGpuFallbackTier(2)).toBeNull()
  })

  // Why: null is what bounds relaunches per build; a non-null answer here is a crash loop.
  it('never escalates past the ladder for out-of-range input', () => {
    expect(getNextGpuFallbackTier(99)).toBeNull()
    expect(getNextGpuFallbackTier(Number.POSITIVE_INFINITY)).toBeNull()
    expect(getNextGpuFallbackTier(Number.NaN)).toBe(1)
    expect(getNextGpuFallbackTier(-5)).toBe(1)
  })

  it('clamps untrusted persisted tiers', () => {
    expect(clampGpuFallbackTier(undefined)).toBe(1)
    expect(clampGpuFallbackTier('2')).toBe(1)
    expect(clampGpuFallbackTier(0)).toBe(1)
    expect(clampGpuFallbackTier(2)).toBe(2)
    expect(clampGpuFallbackTier(2.7)).toBe(2)
    expect(clampGpuFallbackTier(999)).toBe(MAX_GPU_FALLBACK_TIER)
  })

  it('identifies ladder members', () => {
    expect(isGpuFallbackTier(1)).toBe(true)
    expect(isGpuFallbackTier(0)).toBe(false)
    expect(isGpuFallbackTier(3)).toBe(false)
  })

  // Why: escalating must never drop a switch a lower tier already needed.
  it('is additive across tiers', () => {
    const tier1 = new Set(getGpuFallbackTierSwitches(1).map((entry) => entry.name))
    const tier2 = new Set(getGpuFallbackTierSwitches(2).map((entry) => entry.name))
    for (const name of tier1) {
      expect(tier2.has(name)).toBe(true)
    }
  })

  it('takes the compositor off the GPU child and ANGLE off the vendor driver at tier 2', () => {
    expect(getGpuFallbackTierSwitches(1).map((entry) => entry.name)).toEqual(['disable-gpu'])

    const tier2 = getGpuFallbackTierSwitches(2)
    expect(tier2.map((entry) => entry.name)).toContain('disable-gpu-compositing')
    expect(tier2.find((entry) => entry.name === 'use-angle')?.value).toBe('swiftshader')
  })

  // Why: in-process-gpu turns a recoverable child fault into a main-process kill.
  it('never offers in-process-gpu on any rung', () => {
    for (const tier of [1, 2] as const) {
      expect(getGpuFallbackTierSwitches(tier).map((entry) => entry.name)).not.toContain(
        'in-process-gpu'
      )
    }
  })
})

describe('resolveGpuFallbackEscalation', () => {
  it('starts a machine with no history at the bottom of the ladder', () => {
    expect(resolveGpuFallbackEscalation(0, () => null)).toEqual({
      nextTier: 1,
      resumedFromHistory: false
    })
  })

  // Why: this is what turns "unusable after every update" into one relaunch per update.
  it('resumes a hardware launch at the tier the machine already needed', () => {
    expect(resolveGpuFallbackEscalation(0, () => 2)).toEqual({
      nextTier: 2,
      resumedFromHistory: true
    })
    expect(resolveGpuFallbackEscalation(0, () => 1)).toEqual({
      nextTier: 1,
      resumedFromHistory: true
    })
  })

  it('ignores history once a tier is applied and escalates one rung', () => {
    let historyReads = 0
    expect(
      resolveGpuFallbackEscalation(1, () => {
        historyReads += 1
        return 2
      })
    ).toEqual({ nextTier: 2, resumedFromHistory: false })
    expect(historyReads).toBe(0)
  })

  it('reports an exhausted ladder at the top rung', () => {
    expect(resolveGpuFallbackEscalation(2, () => 2)).toEqual({
      nextTier: null,
      resumedFromHistory: false
    })
  })
})
