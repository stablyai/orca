/**
 * Escalation ladder for the Windows GPU-crash fallback.
 *
 * `--disable-gpu` alone does not stop Chromium from spawning a GPU child for the
 * Viz display compositor, so a driver that CHECK-crashes at GPU init keeps
 * killing every launch even with the fallback applied (20 of 21 crashed launches
 * in the reported bundle already carried tier 1). Tier 2 takes the compositor off
 * the GPU child and forces ANGLE onto SwiftShader so the vendor DLL is never loaded.
 *
 * The ladder deliberately stops there. `--in-process-gpu` would remove the child
 * entirely, but it also turns a recoverable child fault into a main-process kill,
 * and nothing in the evidence says tier 2 is insufficient.
 *
 * Tiers are additive on purpose: escalating never drops a switch that a lower
 * tier already needed.
 */

export const GPU_FALLBACK_TIERS = [1, 2] as const

export type GpuFallbackTier = (typeof GPU_FALLBACK_TIERS)[number]

export const MIN_GPU_FALLBACK_TIER: GpuFallbackTier = 1
export const MAX_GPU_FALLBACK_TIER: GpuFallbackTier = 2

/** Tier 0 means "no fallback applied to this launch". */
export const NO_GPU_FALLBACK_TIER = 0

/** A rung, or the hardware path. The only values a launch's current tier may hold. */
export type GpuFallbackTierOrNone = GpuFallbackTier | typeof NO_GPU_FALLBACK_TIER

export type GpuFallbackSwitch = { name: string; value?: string }

const TIER_SWITCHES: Record<GpuFallbackTier, readonly GpuFallbackSwitch[]> = {
  1: [{ name: 'disable-gpu' }],
  2: [
    { name: 'disable-gpu' },
    // Why: moves the display compositor off the GPU child, which tier 1 still spawned.
    { name: 'disable-gpu-compositing' },
    // Why: keeps a broken vendor D3D11 driver DLL out of the process even when Chromium still initializes ANGLE.
    { name: 'use-angle', value: 'swiftshader' }
  ]
}

export function isGpuFallbackTier(value: unknown): value is GpuFallbackTier {
  return GPU_FALLBACK_TIERS.some((tier) => tier === value)
}

/** Coerces a persisted/untrusted tier onto the ladder; anything unrecognized starts at tier 1. */
export function clampGpuFallbackTier(value: unknown): GpuFallbackTier {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MIN_GPU_FALLBACK_TIER
  }
  const rounded = Math.trunc(value)
  if (rounded <= MIN_GPU_FALLBACK_TIER) {
    return MIN_GPU_FALLBACK_TIER
  }
  return rounded >= MAX_GPU_FALLBACK_TIER ? MAX_GPU_FALLBACK_TIER : (rounded as GpuFallbackTier)
}

export function getGpuFallbackTierSwitches(tier: GpuFallbackTier): readonly GpuFallbackSwitch[] {
  return TIER_SWITCHES[tier]
}

/**
 * Next rung above `currentTier` (0 = nothing applied yet), or null once the
 * ladder is exhausted. Null is what bounds relaunches per build.
 */
export function getNextGpuFallbackTier(currentTier: number): GpuFallbackTier | null {
  if (Number.isNaN(currentTier) || currentTier < MIN_GPU_FALLBACK_TIER) {
    return MIN_GPU_FALLBACK_TIER
  }
  if (currentTier >= MAX_GPU_FALLBACK_TIER) {
    return null
  }
  const next = Math.trunc(currentTier) + 1
  return isGpuFallbackTier(next) ? next : null
}

export type GpuFallbackEscalation = {
  nextTier: GpuFallbackTier | null
  resumedFromHistory: boolean
}

/**
 * Tier for the relaunch after a crash burst. History (the strongest tier this
 * machine ever needed) is consulted only when no tier is applied this launch —
 * i.e. the post-update hardware probe just failed. Once on the ladder,
 * escalation is strictly one rung at a time.
 */
export function resolveGpuFallbackEscalation(
  currentTier: number,
  readRequiredTierHistory: () => GpuFallbackTier | null
): GpuFallbackEscalation {
  const resumeTier = currentTier === NO_GPU_FALLBACK_TIER ? readRequiredTierHistory() : null
  return {
    nextTier: resumeTier ?? getNextGpuFallbackTier(currentTier),
    resumedFromHistory: resumeTier !== null
  }
}
