import { expect, it } from 'vitest'
import { teamAllowsUpdate, type TeamUpdateApproval } from './updater-release-policy'

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
