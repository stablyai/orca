import { getMCodeProfileBrowserSessionPartition } from '../../shared/mcode-profiles'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'

const BROWSER_SESSION_PROFILE_ID_RE =
  /^[\da-f-]{8}-[\da-f-]{4}-[\da-f-]{4}-[\da-f-]{4}-[\da-f-]{12}$/

// Why: validate on-disk profile shape so a tampered JSON file can't inject an arbitrary partition into the will-attach-webview allowlist.
export function isValidPersistedBrowserSessionProfile(
  profile: unknown,
  activeMCodeProfileId: string
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
    (candidate.userAgentMode === undefined ||
      candidate.userAgentMode === 'clean' ||
      candidate.userAgentMode === 'native') &&
    isProfileOwnedSessionPartition(candidate.id, candidate.partition, activeMCodeProfileId)
  )
}

function isProfileOwnedSessionPartition(
  profileId: string,
  partition: string,
  activeMCodeProfileId: string
): boolean {
  return (
    BROWSER_SESSION_PROFILE_ID_RE.test(profileId) &&
    partition === getMCodeProfileBrowserSessionPartition(activeMCodeProfileId, profileId)
  )
}
