import { isValidPersistedBrowserSessionProfile } from '../../sessions/profiles/browser-session-persisted-profile-validation'

type PersistedProfileWithUserAgentMode = Record<string, unknown> & {
  readonly userAgentMode: unknown
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
