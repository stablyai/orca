import { userInfo } from 'node:os'
import { getOrcaProfileListState } from '../orca-profiles/profile-index-store'

// Why: mirrors the account-name-then-OS-username fallback so a first-time
// connect dialog can prefill without the user typing anything.
export function resolveDefaultPeerDisplayName(): string {
  const { activeProfileId, profiles } = getOrcaProfileListState()
  const active = profiles.find((profile) => profile.id === activeProfileId)
  if (active?.kind === 'cloud-linked') {
    return active.cloud?.displayName || active.name
  }
  try {
    return userInfo().username
  } catch {
    return active?.name ?? 'Orca'
  }
}
