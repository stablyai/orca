import { compareVersions } from './updater-fallback'
import { updateDelayDaysToMs } from '../shared/update-delay'
import type { DelayedUpdate } from '../shared/update-status-types'
import { AUTO_UPDATE_CHECK_INTERVAL_MS } from './updater/updater-state'

// Absorbs clock skew between this host and GitHub's feed timestamps.
const DELAYED_UPDATE_CLEAR_BUFFER_MS = 5 * 60 * 1000

export type DatedReleaseTag = {
  tag: string
  version: string
  /** GitHub's Atom entry `updated` time: server-side and never earlier than publication. */
  releasedAt: number | null
}

export type HeldRelease = { tag: string; version: string; releasedAt: number }

export type ReleaseDelayResult = {
  /** Newest newer release still inside the delay window. */
  heldRelease: HeldRelease | null
  /** Whether a tag outside the probed candidates (stable fallback) has provably aged out. */
  isTagOldEnough: (tag: string) => boolean
}

export function applyReleaseDelay(
  candidates: DatedReleaseTag[],
  allTags: DatedReleaseTag[],
  currentVersion: string,
  minReleaseAgeMs: number,
  now: number
): { eligible: DatedReleaseTag[]; releaseDelay: ReleaseDelayResult } {
  const cutoff = now - minReleaseAgeMs
  // Unknown dates fail closed: a delay exists to avoid unvetted releases.
  const isOldEnough = (entry: DatedReleaseTag): boolean =>
    entry.releasedAt !== null && entry.releasedAt <= cutoff
  const held = candidates.find(
    (entry) => compareVersions(entry.version, currentVersion) > 0 && !isOldEnough(entry)
  )
  const feedDates = allTags.flatMap((entry) =>
    entry.releasedAt === null ? [] : [entry.releasedAt]
  )
  const oldestFeedDate = feedDates.length ? Math.min(...feedDates) : null
  return {
    eligible: candidates.filter(isOldEnough),
    releaseDelay: {
      heldRelease: held
        ? { tag: held.tag, version: held.version, releasedAt: held.releasedAt ?? now }
        : null,
      isTagOldEnough: (tag) => {
        const entry = allTags.find((candidate) => candidate.tag === tag)
        if (entry) {
          return isOldEnough(entry)
        }
        // Tags absent from the feed predate every entry in it.
        return oldestFeedDate !== null && oldestFeedDate <= cutoff
      }
    }
  }
}

export function toDelayedUpdate(
  heldRelease: HeldRelease | null | undefined,
  delayDays: number
): DelayedUpdate | null {
  if (!heldRelease) {
    return null
  }
  return {
    version: heldRelease.version,
    releasedAt: new Date(heldRelease.releasedAt).toISOString(),
    availableAt: new Date(heldRelease.releasedAt + updateDelayDaysToMs(delayDays)).toISOString(),
    delayDays
  }
}

/** Wake when a held release clears, unless the routine daily check comes first. */
export function getDelayedUpdateWakeDelayMs(
  delayedUpdate: DelayedUpdate,
  now: number
): number | null {
  const untilClearedMs = Date.parse(delayedUpdate.availableAt) - now
  if (untilClearedMs >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
    return null
  }
  return Math.max(untilClearedMs, 0) + DELAYED_UPDATE_CLEAR_BUFFER_MS
}
