import { expect, it } from 'vitest'
import { createDefaultLocalOrcaProfile } from '../../../shared/orca-profiles/orca-profiles'
import {
  isOrcaCloudTeamFeatureBlocked,
  ORCA_CLOUD_TEAM_POLICY_FLAGS as flags
} from '../../../shared/orca-profiles/orca-cloud-team-policy'
import {
  initializeActiveTeamProfile,
  isTeamFeatureBlocked,
  observeActiveTeamProfile
} from './active-team-capabilities'

it('keeps membership policy on the personal account without carrying it across account identities', () => {
  const cloud = {
    userId: 'user_a',
    cloudProfileId: 'cloud_a',
    email: 'a@example.test',
    linkedAt: 1
  }
  const profile = { ...createDefaultLocalOrcaProfile(1), cloud }
  const capabilities = {
    flags: { team_settings: true, 'relay.use': false },
    teamPolicy: { orgIds: ['org_a'] },
    refreshedAt: 1
  }
  const finish = initializeActiveTeamProfile('/orca', {
    ...profile,
    cloud: { ...cloud, activeOrgId: 'org_a' }
  })
  finish({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 2,
    identity: cloud,
    capabilities
  })

  observeActiveTeamProfile('/orca', profile)
  expect(isTeamFeatureBlocked(flags.mobileRelay)).toBe(true)
  expect(
    isOrcaCloudTeamFeatureBlocked(
      {
        activeProfileId: profile.id,
        configured: true,
        state: 'connected',
        persistence: 'encrypted',
        cloud,
        capabilities
      },
      flags.mobileRelay
    )
  ).toBe(true)

  observeActiveTeamProfile('/orca', { ...profile, cloud: { ...cloud, userId: 'user_b' } })
  expect(isTeamFeatureBlocked(flags.mobileRelay)).toBe(false)
})
