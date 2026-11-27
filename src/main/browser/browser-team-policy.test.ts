import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultLocalOrcaProfile } from '../../shared/orca-profiles/orca-profiles'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../shared/orca-profiles/orca-cloud-team-policy'
import {
  initializeActiveTeamProfile,
  observeActiveTeamSession
} from '../orca-profiles/cloud-auth/active-team-capabilities'
import { assertTeamAllowsBrowserRpc, assertTeamAllowsBrowserUse } from './browser-team-policy'

const ROOT = '/orca-browser-policy-test'

function setTeamBrowserUseFlag(allowed: boolean | undefined): void {
  const cloud = {
    userId: 'user_1',
    cloudProfileId: 'cloud_1',
    email: 'member@example.test',
    linkedAt: 1,
    activeOrgId: 'org_1'
  }
  const profile = { ...createDefaultLocalOrcaProfile(1), cloud }
  const finish = initializeActiveTeamProfile(ROOT, profile)
  finish({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 2,
    identity: cloud,
    capabilities: {
      flags: {
        team_settings: true,
        ...(allowed === undefined ? {} : { [ORCA_CLOUD_TEAM_POLICY_FLAGS.browserUse]: allowed })
      },
      teamPolicy: { orgIds: ['org_1'] },
      refreshedAt: 1
    }
  })
}

afterEach(() => {
  const profile = createDefaultLocalOrcaProfile(1)
  initializeActiveTeamProfile(ROOT, profile)(undefined)
  observeActiveTeamSession(ROOT, profile.id, undefined)
})

describe('browser-team-policy', () => {
  it('blocks agent CLI callers and agent-only methods while allowing human browser viewing', () => {
    setTeamBrowserUseFlag(false)

    expect(() => assertTeamAllowsBrowserUse()).toThrow('Browser Use is turned off by your team.')
    expect(() => assertTeamAllowsBrowserRpc('browser.goto', { kind: 'local-cli' })).toThrow(
      'Browser Use is turned off by your team.'
    )
    expect(() =>
      assertTeamAllowsBrowserRpc('browser.tabCreate', {
        kind: 'paired-device',
        deviceId: 'dev_1',
        agent: true
      })
    ).toThrow('Browser Use is turned off by your team.')
    expect(() =>
      assertTeamAllowsBrowserRpc('browser.snapshot', { kind: 'paired-device', deviceId: 'dev_1' })
    ).toThrow('Browser Use is turned off by your team.')
    expect(() => assertTeamAllowsBrowserRpc('browser.eval', { kind: 'desktop' })).toThrow(
      'Browser Use is turned off by your team.'
    )

    // Human browsing via desktop or paired phone stays allowed.
    expect(() => assertTeamAllowsBrowserRpc('browser.goto', { kind: 'desktop' })).not.toThrow()
    expect(() =>
      assertTeamAllowsBrowserRpc('browser.goto', { kind: 'paired-device', deviceId: 'dev_1' })
    ).not.toThrow()
    expect(() =>
      assertTeamAllowsBrowserRpc('browser.screencast', { kind: 'paired-device', deviceId: 'dev_1' })
    ).not.toThrow()
    expect(() => assertTeamAllowsBrowserRpc('terminal.list', { kind: 'local-cli' })).not.toThrow()
  })

  it('allows browser use when the team policy does not disable it', () => {
    setTeamBrowserUseFlag(true)
    expect(() => assertTeamAllowsBrowserUse()).not.toThrow()
    expect(() =>
      assertTeamAllowsBrowserRpc('browser.snapshot', { kind: 'local-cli' })
    ).not.toThrow()

    setTeamBrowserUseFlag(undefined)
    expect(() =>
      assertTeamAllowsBrowserRpc('browser.snapshot', { kind: 'local-cli' })
    ).not.toThrow()
  })
})
