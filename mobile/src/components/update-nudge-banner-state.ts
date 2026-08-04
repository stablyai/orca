// Why: decides the soft "update your app" nudge. Deliberately fail-open —
// any missing or unparsable version (older desktop, dev build) means no
// banner, because a wrong nudge is worse than no nudge.

function parseVersionSegments(version: string): number[] | null {
  const trimmed = version.trim()
  if (!/^\d+(\.\d+)*$/.test(trimmed)) {
    return null
  }
  const segments = trimmed.split('.').map(Number)
  return segments.every(Number.isSafeInteger) ? segments : null
}

export function getRecommendedVersionForPlatform(
  platform: string,
  versions: { ios?: string; android?: string } | null | undefined
): string | null {
  if (platform !== 'ios' && platform !== 'android') {
    return null
  }
  const version = versions?.[platform]
  return typeof version === 'string' ? version : null
}

// Why: numeric per-segment compare — string compare would rank 0.0.9 above
// 0.0.32. Missing segments count as 0 so 1.4 equals 1.4.0.
function compareAppVersions(left: string, right: string): number | null {
  const leftSegments = parseVersionSegments(left)
  const rightSegments = parseVersionSegments(right)
  if (!leftSegments || !rightSegments) {
    return null
  }
  const length = Math.max(leftSegments.length, rightSegments.length)
  for (let index = 0; index < length; index++) {
    const leftSegment = leftSegments[index] ?? 0
    const rightSegment = rightSegments[index] ?? 0
    if (leftSegment !== rightSegment) {
      return leftSegment < rightSegment ? -1 : 1
    }
  }
  return 0
}

export function isAppVersionOlder(installed: string, recommended: string): boolean {
  return compareAppVersions(installed, recommended) === -1
}

export function shouldShowUpdateNudge(input: {
  recommendedVersion: string | null | undefined
  installedVersion: string | null | undefined
  dismissedVersion: string | null
  // Why: hold the banner until the dismissal read settles, so a user who
  // already dismissed this version never sees it flash on mount.
  dismissedLoaded: boolean
}): boolean {
  const { recommendedVersion, installedVersion, dismissedVersion, dismissedLoaded } = input
  if (!recommendedVersion || !installedVersion || !dismissedLoaded) {
    return false
  }
  // Why: dismissal is per-version — the nudge returns when a newer mobile
  // release ships and the desktop starts recommending a different version.
  const dismissalComparison = dismissedVersion
    ? compareAppVersions(dismissedVersion, recommendedVersion)
    : null
  if (dismissalComparison !== null && dismissalComparison >= 0) {
    return false
  }
  return isAppVersionOlder(installedVersion, recommendedVersion)
}
