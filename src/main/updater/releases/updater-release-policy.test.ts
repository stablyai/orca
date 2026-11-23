import { expect, it } from 'vitest'
import {
  releaseSelectionPolicy,
  teamAllowsUpdate,
  type TeamUpdateApproval
} from './updater-release-policy'

it('requires a release offer to match the team, channel, and delay applied at installation', () => {
  const policy = { orgIds: ['org_a', 'org_b'], updateChannel: 'rc', updateDelayDays: 7 } as const
  const approval: TeamUpdateApproval = { policy, tags: ['v2.0.0-rc.1', 'v1.9.8'] }
  expect(
    teamAllowsUpdate({ ...policy, orgIds: ['org_a', 'org_b'] }, approval, '2.0.0-rc.1', true)
  ).toBe(true)
  expect(teamAllowsUpdate(policy, approval, '1.9.8', true)).toBe(true)
  expect(teamAllowsUpdate(policy, approval, '2.0.0-rc.1', false)).toBe(false)
  expect(teamAllowsUpdate(policy, approval, '2.0.0', true)).toBe(false)
  expect(teamAllowsUpdate({ ...policy, orgIds: ['org_b'] }, approval, '1.9.8', true)).toBe(false)
  expect(
    teamAllowsUpdate({ ...policy, updateChannel: 'stable' }, approval, '2.0.0-rc.1', true)
  ).toBe(false)
  expect(teamAllowsUpdate({ ...policy, updateDelayDays: 14 }, approval, '1.9.8', true)).toBe(false)
  expect(teamAllowsUpdate(policy, null, '1.9.8', true)).toBe(false)
  expect(teamAllowsUpdate(undefined, null, '2.0.0-rc.1', false)).toBe(true)
})

it('uses the forcing team delay and revokes a cached offer when the required minimum changes', () => {
  const policy = {
    orgIds: ['org_a', 'org_b'],
    updateChannel: 'stable',
    updateDelayDays: 30,
    forceUpdates: true,
    forceUpdateDelayDays: 7,
    minimumVersion: '2.1.0'
  } as const
  expect(
    releaseSelectionPolicy({
      team: policy,
      variant: 'default',
      version: '2.0.0',
      includePrerelease: true,
      ignoreDelay: true,
      getUpdateDelayDays: () => 0
    })
  ).toEqual({ isPerfCheck: false, includePrerelease: false, delayDays: 7, minimumVersion: '2.1.0' })
  const approval = { policy, tags: ['v2.1.0'] }
  expect(teamAllowsUpdate(policy, approval, '2.1.0', true)).toBe(true)
  expect(teamAllowsUpdate({ ...policy, minimumVersion: '2.1.1' }, approval, '2.1.0', true)).toBe(
    false
  )
})
