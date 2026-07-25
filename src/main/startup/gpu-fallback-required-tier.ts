import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clampGpuFallbackTier, isGpuFallbackTier, type GpuFallbackTier } from './gpu-fallback-tiers'

/**
 * Version-independent record of the strongest fallback tier this machine has needed.
 *
 * The crash marker is scoped to appVersion+electronVersion so a new build gets a
 * fresh hardware attempt — deliberate, since a driver or Electron update may fix
 * the machine. But that scoping also discarded everything we had learned: every
 * update replayed the entire crash loop from the bottom of the ladder, which is
 * what made the app repeatedly unusable rather than once-unusable.
 *
 * This record survives updates. The post-update hardware probe still happens, but
 * when it fails the app resumes at the tier it already needed instead of walking
 * the ladder again.
 *
 * It is a hint, not an authority: any read failure degrades to normal escalation,
 * so a corrupt or unreadable file costs extra relaunches, never correctness.
 */

export const GPU_FALLBACK_REQUIRED_TIER_FILE = 'gpu-fallback-required-tier.json'
const GPU_FALLBACK_REQUIRED_TIER_TEMP_FILE = `${GPU_FALLBACK_REQUIRED_TIER_FILE}.tmp`
export const GPU_FALLBACK_REQUIRED_TIER_SCHEME_VERSION = 1

export type GpuFallbackRequiredTierRecord = {
  schemeVersion: number
  requiredTier: GpuFallbackTier
  recordedAt: number
  /** Build that last needed this tier. Diagnostic only — it never scopes validity. */
  appVersion: string
  electronVersion: string
}

function recordPath(userDataPath: string): string {
  return join(userDataPath, GPU_FALLBACK_REQUIRED_TIER_FILE)
}

export function readGpuFallbackRequiredTier(
  userDataPath: string
): GpuFallbackRequiredTierRecord | null {
  let parsed: Partial<Record<keyof GpuFallbackRequiredTierRecord, unknown>>
  try {
    parsed = JSON.parse(readFileSync(recordPath(userDataPath), 'utf-8')) as Partial<
      Record<keyof GpuFallbackRequiredTierRecord, unknown>
    >
  } catch {
    return null
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.schemeVersion !== GPU_FALLBACK_REQUIRED_TIER_SCHEME_VERSION ||
    !isGpuFallbackTier(parsed.requiredTier) ||
    typeof parsed.recordedAt !== 'number' ||
    !Number.isFinite(parsed.recordedAt)
  ) {
    return null
  }
  return {
    schemeVersion: GPU_FALLBACK_REQUIRED_TIER_SCHEME_VERSION,
    requiredTier: clampGpuFallbackTier(parsed.requiredTier),
    recordedAt: parsed.recordedAt,
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
    electronVersion: typeof parsed.electronVersion === 'string' ? parsed.electronVersion : ''
  }
}

/**
 * Raises the recorded tier to `tier`. Monotonic: a machine that once needed tier 2
 * must not be talked back down to tier 1 by a later, shallower crash burst.
 * Returns the tier now on disk, or null if it could not be persisted.
 */
export function recordGpuFallbackRequiredTier(
  userDataPath: string,
  tier: GpuFallbackTier,
  environment: { appVersion: string; electronVersion: string },
  now: number
): GpuFallbackTier | null {
  const existing = readGpuFallbackRequiredTier(userDataPath)
  if (existing && existing.requiredTier >= tier) {
    return existing.requiredTier
  }
  const record: GpuFallbackRequiredTierRecord = {
    schemeVersion: GPU_FALLBACK_REQUIRED_TIER_SCHEME_VERSION,
    requiredTier: tier,
    recordedAt: now,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion
  }
  const tempPath = join(userDataPath, GPU_FALLBACK_REQUIRED_TIER_TEMP_FILE)
  try {
    writeFileSync(tempPath, JSON.stringify(record))
    renameSync(tempPath, recordPath(userDataPath))
    return tier
  } catch {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // best effort; a stray temp file is inert
    }
    return null
  }
}

/**
 * Tier to resume at when a hardware launch fails and no build-scoped marker exists,
 * or null when this machine has no history and should start at the bottom.
 */
export function getResumeGpuFallbackTier(userDataPath: string): GpuFallbackTier | null {
  return readGpuFallbackRequiredTier(userDataPath)?.requiredTier ?? null
}
