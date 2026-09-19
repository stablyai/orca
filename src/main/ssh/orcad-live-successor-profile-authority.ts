import { isAbsolute, relative, sep } from 'node:path'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parseOrcadLiveCutoverIntent } from './orcad-live-cutover-intent-store'
import { readOrcadLiveProfileParticipation } from './orcad-live-profile-participation'
import { retainProfileLifetimeSuccessorAuthority } from './profile-lifetime-successor-authority'
import { captureSshResetProfileIdentity } from './ssh-reset-profile-identity'

/** Excludes the originating profile holder, not surviving remote transports or pending work. */
export function retainOrcadLiveSuccessorProfileAuthority(
  profileDirectory: string,
  value: unknown
): () => void {
  const intent = parseOrcadLiveCutoverIntent(value)
  if (!intent.profileParticipationRequired) {
    throw new Error('orcad_live_successor_participation_marker_required')
  }
  const profile = captureSshResetProfileIdentity(profileDirectory)
  profile.assertCurrent()
  const historical = readOrcadLiveProfileParticipation(profileDirectory, intent)
  if (!historical) {
    throw new Error('orcad_live_successor_participation_missing')
  }
  const child = relative(historical.participation.physicalRoot, profile.physicalPath)
  if (
    isAbsolute(child) ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    historical.physicalProfile !== profile.physicalPath ||
    serializeOrcadMigrationValue(historical.profileIdentity) !==
      serializeOrcadMigrationValue(profile.filesystemIdentity)
  ) {
    throw new Error('orcad_live_successor_profile_changed')
  }
  const assertSuccessor = retainProfileLifetimeSuccessorAuthority(historical.participation)
  const expected = serializeOrcadMigrationValue(historical)
  const assertCurrent = () => {
    assertSuccessor()
    profile.assertCurrent()
    if (
      serializeOrcadMigrationValue(readOrcadLiveProfileParticipation(profileDirectory, intent)) !==
      expected
    ) {
      throw new Error('orcad_live_successor_participation_changed')
    }
    profile.assertCurrent()
    assertSuccessor()
  }
  assertCurrent()
  return assertCurrent
}
