import { expect, it } from 'vitest'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import { createHarness, flush, notification, registration } from './push-dispatcher.test-fixture'

// Host B runs the session and the shared phone is paired with it; desktop A mirrors the session.
function hosts(options: { hostUnreachable?: boolean; hostGatewayRefuses?: boolean } = {}) {
  const host = createHarness({
    ...(options.hostGatewayRefuses
      ? { results: [{ registrationId: 'b-both', status: 'rate_limited' as const }] }
      : {}),
    devices: [
      {
        deviceId: 'phone-on-both',
        pushRegistration: registration({ registrationId: 'b-both', tokenDigest: 'digest-both' })
      }
    ]
  })
  const mirror = createHarness({
    devices: [
      {
        deviceId: 'phone-on-both',
        pushRegistration: registration({ registrationId: 'a-both', tokenDigest: 'digest-both' })
      },
      {
        deviceId: 'phone-on-mirror',
        pushRegistration: registration({ registrationId: 'a-mirror', tokenDigest: 'digest-mirror' })
      }
    ],
    resolveCoverage: async (executionHost, request) => {
      expect(executionHost).toBe('runtime:env-b')
      if (options.hostUnreachable) {
        throw new Error('host unreachable')
      }
      return new Set(await host.dispatcher.coveredTokenDigests(request))
    }
  })
  const pushesTo = (registrationId: string) =>
    [...host.sends, ...mirror.sends].filter((send) => send.registrationIds.includes(registrationId))
      .length
  return {
    hostSends: (overrides: Partial<MobileNotificationEvent> = {}) =>
      host.dispatcher.enqueue(notification({ emittedAt: Date.now(), ...overrides })),
    mirrorSends: async (overrides: Partial<MobileNotificationEvent> = {}) => {
      mirror.dispatcher.enqueue(
        notification({ emittedAt: Date.now(), executionHost: 'runtime:env-b', ...overrides })
      )
      await flush()
    },
    sharedPhonePushes: () => pushesTo('b-both') + pushesTo('a-both'),
    mirrorPushedSharedPhone: () => pushesTo('a-both') === 1,
    mirrorOnlyPhonePushes: () => pushesTo('a-mirror')
  }
}

it('pushes the shared phone once whether the host sends or the mirror asks first', async () => {
  const hostFirst = hosts()
  hostFirst.hostSends()
  await hostFirst.mirrorSends()
  expect([hostFirst.sharedPhonePushes(), hostFirst.mirrorOnlyPhonePushes()]).toEqual([1, 1])

  const mirrorFirst = hosts()
  await mirrorFirst.mirrorSends()
  mirrorFirst.hostSends()
  await flush()
  expect([mirrorFirst.sharedPhonePushes(), mirrorFirst.mirrorOnlyPhonePushes()]).toEqual([1, 1])
})

it('leaves the shared phone to the mirror when the host does not push it', async () => {
  const hostAwayRuleRefuses = hosts()
  hostAwayRuleRefuses.hostSends({ desktopAllowed: false })
  await hostAwayRuleRefuses.mirrorSends()
  expect(hostAwayRuleRefuses.sharedPhonePushes()).toBe(1)

  // A muted workspace never reaches the host's dispatcher.
  const hostNeverSends = hosts()
  await hostNeverSends.mirrorSends()
  expect(hostNeverSends.sharedPhonePushes()).toBe(1)

  const hostGatewayRefuses = hosts({ hostGatewayRefuses: true })
  hostGatewayRefuses.hostSends()
  await hostGatewayRefuses.mirrorSends()
  expect(hostGatewayRefuses.mirrorPushedSharedPhone()).toBe(true)
})

it('collapses a burst across both hosts as the host collapses its own', async () => {
  const h = hosts()
  h.hostSends()
  await h.mirrorSends()
  h.hostSends({ notificationId: 'agent:two', emittedAt: Date.now() + 2_000 })
  await h.mirrorSends({ notificationId: 'agent:two' })
  expect(h.sharedPhonePushes()).toBe(1)
})

it('pushes every phone when the host cannot answer', async () => {
  const h = hosts({ hostUnreachable: true })
  await h.mirrorSends()
  expect([h.sharedPhonePushes(), h.mirrorOnlyPhonePushes()]).toEqual([1, 1])
})
