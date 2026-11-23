import { expect, it } from 'vitest'
import {
  applyEmergencyUpdateFloor,
  releaseSelectionPolicy,
  requiresTeamRelease,
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

it('enforces the emergency floor through verified release selection only while governed and below it', () => {
  const team = {
    orgIds: ['org_a'],
    updateChannel: 'rc',
    updateDelayDays: 30,
    minimumVersion: '3.0.0',
    forceUpdates: true,
    forceUpdateDelayDays: 21
  } as const
  const floor = '2.0.0'
  const current = '1.9.0'
  const original = { policy: team, tags: ['v1.9.1-rc.1'] }
  const emergency = applyEmergencyUpdateFloor(team, floor, current)
  expect(applyEmergencyUpdateFloor(undefined, floor, current)).toBeUndefined()
  expect(applyEmergencyUpdateFloor(team, floor, floor)).toBe(team)
  expect(
    releaseSelectionPolicy({
      team: emergency,
      variant: 'perf',
      version: current,
      includePrerelease: true,
      ignoreDelay: false,
      getUpdateDelayDays: () => 30
    })
  ).toEqual({ isPerfCheck: false, includePrerelease: false, delayDays: 0, minimumVersion: floor })
  expect(requiresTeamRelease(emergency, current, '1.9.1')).toBe(false)
  expect(requiresTeamRelease(emergency, current, floor)).toBe(true)
  expect(teamAllowsUpdate(emergency, original, '1.9.1-rc.1', true)).toBe(false)
  expect(teamAllowsUpdate(emergency, { policy: emergency, tags: ['v2.0.0'] }, floor, true)).toBe(
    true
  )
  expect(teamAllowsUpdate(team, { policy: emergency, tags: ['v2.0.0'] }, floor, true)).toBe(false)
})
