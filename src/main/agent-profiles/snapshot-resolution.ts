// A runtime observation may update the executable, while saved account ownership stays fixed.
import type { AgentLaunchProfile, AgentProfileSnapshot } from '../../shared/agent-launch-profile'
import type { AgentProfileCandidate } from './connection-contracts'
import type { ProfilePreparationOptions } from './provider-adapters'

export function validateResolvedProfileSnapshot(
  profile: AgentLaunchProfile | AgentProfileSnapshot,
  candidate: AgentProfileCandidate,
  options: ProfilePreparationOptions
): AgentProfileSnapshot {
  if ('resolvedHome' in profile && candidate.resolvedHome !== profile.resolvedHome) {
    throw new Error('Profile home changed. Reconnect the profile.')
  }
  if (
    'identity' in profile &&
    profile.identity.kind === 'verified' &&
    (candidate.identity.kind !== 'verified' ||
      profile.identity.subject !== candidate.identity.subject)
  ) {
    throw new Error('Profile identity changed or cannot be verified. Reconnect the profile.')
  }
  if (
    (candidate.identity.kind === 'unverified' ||
      ('identity' in profile && profile.identity.kind === 'unverified')) &&
    (options.resume || options.mode === 'structured')
  ) {
    throw new Error('Unverified identity supports fresh terminal launch only.')
  }
  const snapshot: AgentProfileSnapshot = {
    id: profile.id,
    name: profile.name,
    agent: candidate.agent,
    hostId: candidate.hostId,
    executable: candidate.executable,
    binding: { ...profile.binding },
    resolvedHome: candidate.resolvedHome,
    identity: { ...candidate.identity }
  }
  return snapshot
}
