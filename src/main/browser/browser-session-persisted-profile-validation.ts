import { getOrcaProfileBrowserSessionPartition } from '../../shared/orca-profiles'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'

const BROWSER_SESSION_PROFILE_ID_RE =
  /^[\da-f-]{8}-[\da-f-]{4}-[\da-f-]{4}-[\da-f-]{4}-[\da-f-]{12}$/

type PersistedProfileWithUserAgentMode = Record<string, unknown> & {
  readonly userAgentMode: unknown
}

// Persisted metadata must not add arbitrary partitions to the webview allowlist.
export function isValidPersistedBrowserSessionProfile(
  profile: unknown,
  activeOrcaProfileId: string
): profile is BrowserSessionProfile {
  if (!profile || typeof profile !== 'object') {
    return false
  }
  const candidate = profile as Partial<BrowserSessionProfile>
  return (
    candidate.id !== 'default' &&
    candidate.scope !== 'default' &&
    typeof candidate.id === 'string' &&
    typeof candidate.partition === 'string' &&
    typeof candidate.label === 'string' &&
    isProfileOwnedSessionPartition(candidate.id, candidate.partition, activeOrcaProfileId)
  )
}

export function inspectRetiredBrowserSessionProfileUserAgentModes(
  profiles: readonly unknown[],
  activeOrcaProfileId: string
): { noticePending: boolean; degraded: boolean } {
  let noticePending = false
  let degraded = false
  for (const profile of profiles) {
    // Invalid profiles without a retired choice must not trigger a migration notice.
    if (!isRecord(profile) || !hasPersistedProfileUserAgentMode(profile)) {
      continue
    }
    noticePending = true
    const mode = profile.userAgentMode
    // Unknown modes and unhydratable profiles make the retired choice uninspectable.
    if (
      (mode !== 'clean' && mode !== 'native') ||
      !isValidPersistedBrowserSessionProfile(profile, activeOrcaProfileId)
    ) {
      degraded = true
    }
  }
  return { noticePending, degraded }
}

function hasPersistedProfileUserAgentMode(
  profile: Record<string, unknown>
): profile is PersistedProfileWithUserAgentMode {
  return Object.hasOwn(profile, 'userAgentMode')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isProfileOwnedSessionPartition(
  profileId: string,
  partition: string,
  activeOrcaProfileId: string
): boolean {
  return (
    BROWSER_SESSION_PROFILE_ID_RE.test(profileId) &&
    partition === getOrcaProfileBrowserSessionPartition(activeOrcaProfileId, profileId)
  )
}
