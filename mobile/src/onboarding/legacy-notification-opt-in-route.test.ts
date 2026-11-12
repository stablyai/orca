import { describe, expect, it } from 'vitest'
import { legacyNotificationOptInDestination } from './legacy-notification-opt-in-destination'

describe('legacy notification opt-in destination', () => {
  it('selects only notifications and preserves a scalar hostId', () => {
    expect(legacyNotificationOptInDestination({ hostId: 'paired-host' })).toEqual({
      pathname: '/mobile-onboarding',
      params: { steps: 'notifications', hostId: 'paired-host' }
    })
  })

  it('ignores unrelated legacy parameters', () => {
    const legacyParams = {
      hostId: 'paired-host',
      steps: 'session-view',
      returnTo: '/settings'
    }

    expect(legacyNotificationOptInDestination(legacyParams)).toEqual({
      pathname: '/mobile-onboarding',
      params: { steps: 'notifications', hostId: 'paired-host' }
    })
  })
})
