import { describe, expect, it } from 'vitest'
import { getOrcaProfileBrowserSessionPartition } from '../../shared/orca-profiles'
import { inspectRetiredBrowserSessionProfileUserAgentModes } from './browser-session-persisted-profile-validation'

const ORCA_PROFILE_ID = 'local-default'
const PROFILE_ID = '11111111-1111-4111-8111-111111111111'

function profileWithMode(mode: unknown): Record<string, unknown> {
  return {
    id: PROFILE_ID,
    scope: 'isolated',
    partition: getOrcaProfileBrowserSessionPartition(ORCA_PROFILE_ID, PROFILE_ID),
    label: 'Existing',
    source: null,
    userAgentMode: mode
  }
}

function unhydratableProfile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'not-a-uuid',
    scope: 'isolated',
    partition: 'persist:orca-browser-session-not-a-uuid',
    label: 'Unhydratable',
    source: null,
    ...extra
  }
}

describe('retired browser profile identity inspection', () => {
  it('detects an inspectable old choice without removing its bytes', () => {
    const profile = profileWithMode('native')

    expect(inspectRetiredBrowserSessionProfileUserAgentModes([profile], ORCA_PROFILE_ID)).toEqual({
      noticePending: true,
      degraded: false
    })
    expect(profile.userAgentMode).toBe('native')
  })

  it.each([
    { scenario: 'null', entry: null },
    { scenario: 'a number', entry: 42 },
    { scenario: 'a string', entry: 'broken' },
    {
      scenario: 'a profile that fails validation for an unrelated reason',
      entry: unhydratableProfile()
    }
  ])('stays silent about $scenario, which carries no identity choice', ({ entry }) => {
    expect(inspectRetiredBrowserSessionProfileUserAgentModes([entry], ORCA_PROFILE_ID)).toEqual({
      noticePending: false,
      degraded: false
    })
  })

  it.each([
    { scenario: 'an unreadable mode', entry: profileWithMode('unexpected') },
    {
      scenario: 'a mode on an entry that cannot be hydrated',
      entry: unhydratableProfile({ userAgentMode: 'native' })
    }
  ])('turns $scenario into a degraded notice without throwing', ({ entry }) => {
    expect(() =>
      inspectRetiredBrowserSessionProfileUserAgentModes([entry], ORCA_PROFILE_ID)
    ).not.toThrow()
    expect(inspectRetiredBrowserSessionProfileUserAgentModes([entry], ORCA_PROFILE_ID)).toEqual({
      noticePending: true,
      degraded: true
    })
  })
})
