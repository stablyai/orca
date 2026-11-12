import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldPresentNotificationOptIn } from '../notifications/delivery-policy/notification-opt-in-gate'
import { shouldPresentSessionViewOptIn } from '../session/session-view-opt-in-gate'
import { mobileOnboardingDestination, parseMobileOnboardingSteps } from './mobile-onboarding-plan'

vi.mock('../notifications/delivery-policy/notification-opt-in-gate', () => ({
  shouldPresentNotificationOptIn: vi.fn()
}))
vi.mock('../session/session-view-opt-in-gate', () => ({
  shouldPresentSessionViewOptIn: vi.fn()
}))

describe('mobile onboarding plan', () => {
  beforeEach(() => {
    vi.mocked(shouldPresentNotificationOptIn).mockReset().mockResolvedValue(false)
    vi.mocked(shouldPresentSessionViewOptIn).mockReset().mockResolvedValue(false)
  })

  it.each([
    [[], undefined, '/'],
    [[], 'paired-host', '/h/paired-host'],
    [
      ['session-view', 'notifications'],
      undefined,
      {
        pathname: '/mobile-onboarding',
        params: { steps: 'session-view,notifications' }
      }
    ],
    [
      ['notifications'],
      'paired-host',
      {
        pathname: '/mobile-onboarding',
        params: { steps: 'notifications', hostId: 'paired-host' }
      }
    ]
  ] as const)('maps %j with host %s to the correct destination', (steps, hostId, destination) => {
    expect(mobileOnboardingDestination(steps, hostId)).toEqual(destination)
  })

  it('parses route steps in canonical order without duplicates', () => {
    expect(parseMobileOnboardingSteps('notifications,unknown,session-view,notifications')).toEqual([
      'session-view',
      'notifications'
    ])
    expect(parseMobileOnboardingSteps('notifications')).toEqual(['notifications'])
  })
})
