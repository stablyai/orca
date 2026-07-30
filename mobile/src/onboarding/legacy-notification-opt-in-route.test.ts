import { describe, expect, it, vi } from 'vitest'
import NotificationOptInRedirect from '../../app/notification-opt-in'
import { legacyNotificationOptInDestination } from './legacy-notification-opt-in-destination'

const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string | string[] | undefined>,
  ensureNotificationPermissions: vi.fn()
}))

vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  useLocalSearchParams: () => mocks.params
}))

vi.mock('../notifications/mobile-notifications', () => ({
  ensureNotificationPermissions: mocks.ensureNotificationPermissions
}))

describe('legacy notification opt-in destination', () => {
  it('selects only notifications and preserves a scalar hostId', () => {
    expect(legacyNotificationOptInDestination({ hostId: 'paired-host' })).toEqual({
      pathname: '/mobile-onboarding',
      params: { steps: 'notifications', hostId: 'paired-host' }
    })
  })

  it.each([
    [['first-host', 'second-host'], 'first-host'],
    [[], undefined],
    [undefined, undefined]
  ] as const)('normalizes hostId %j to %s', (hostId, expectedHostId) => {
    expect(legacyNotificationOptInDestination({ hostId })).toEqual({
      pathname: '/mobile-onboarding',
      params: {
        steps: 'notifications',
        ...(expectedHostId ? { hostId: expectedHostId } : {})
      }
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

describe('/notification-opt-in compatibility route', () => {
  it('is present and synchronously returns a replace-style redirect to the canonical route', () => {
    mocks.params = {
      hostId: ['paired-host', 'ignored-host'],
      steps: 'session-view',
      unrelated: 'ignored'
    }

    expect(NotificationOptInRedirect()).toMatchObject({
      type: 'Redirect',
      props: {
        href: {
          pathname: '/mobile-onboarding',
          params: { steps: 'notifications', hostId: 'paired-host' }
        }
      }
    })
    expect(mocks.ensureNotificationPermissions).not.toHaveBeenCalled()
  })
})
