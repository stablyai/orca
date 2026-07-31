import { compareVersions, type AndroidRelease } from './android-release-feed'

// Why: one check per day, not per launch. The app restarts constantly during
// normal use and a version only changes when we cut a release, so a daily
// budget keeps this to ~1 request/day/device against GitHub's unauthenticated
// 60/hour/IP limit.
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export type UpdateCheckState = {
  lastCheckedAtMs?: number
  dismissedVersion?: string
}

export type UpdateCheckDecision =
  | { kind: 'skip'; reason: 'not-android' | 'checked-recently' }
  | { kind: 'check' }

export type UpdateVerdict =
  | { kind: 'up-to-date' }
  | { kind: 'dismissed'; version: string }
  | { kind: 'update-available'; release: AndroidRelease }

export function shouldCheckForUpdate(input: {
  platform: string
  state: UpdateCheckState
  nowMs: number
}): UpdateCheckDecision {
  // Why: iOS updates arrive through TestFlight, which already notifies the
  // user. Only the sideloaded Android APK has no such channel.
  if (input.platform !== 'android') {
    return { kind: 'skip', reason: 'not-android' }
  }
  const lastCheckedAtMs = input.state.lastCheckedAtMs
  if (
    typeof lastCheckedAtMs === 'number' &&
    input.nowMs - lastCheckedAtMs < UPDATE_CHECK_INTERVAL_MS &&
    input.nowMs >= lastCheckedAtMs
  ) {
    return { kind: 'skip', reason: 'checked-recently' }
  }
  return { kind: 'check' }
}

export function evaluateUpdate(input: {
  currentVersion: string
  release: AndroidRelease | null
  dismissedVersion?: string
}): UpdateVerdict {
  const { currentVersion, release, dismissedVersion } = input
  if (!release || compareVersions(release.version, currentVersion) <= 0) {
    return { kind: 'up-to-date' }
  }
  // Why: "Later" silences this one version only — the next release asks again.
  if (dismissedVersion && compareVersions(release.version, dismissedVersion) <= 0) {
    return { kind: 'dismissed', version: release.version }
  }
  return { kind: 'update-available', release }
}
