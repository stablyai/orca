import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import type { PushSendResult } from './push-gateway-client'
import { createHarness, flush, notification, registration } from './push-dispatcher.test-fixture'

const NOW = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

const refused = (registrationId: string): PushSendResult[] => [
  { registrationId, status: 'rate_limited' }
]

// Host B runs the session and the shared phone is paired with it; desktop A mirrors the session.
function hosts(
  options: {
    hostUnreachable?: boolean
    hostResults?: PushSendResult[]
    mirrorResults?: PushSendResult[]
  } = {}
) {
  const host = createHarness({
    devices: [
      {
        deviceId: 'phone-on-both',
        pushRegistration: registration({ registrationId: 'b-both', tokenDigest: 'digest-both' })
      }
    ],
    results: options.hostResults
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
    results: options.mirrorResults,
    coverage: {
      ask: async (executionHost, request) => {
        expect(executionHost).toBe('runtime:env-b')
        if (options.hostUnreachable) {
          throw new Error('host unreachable')
        }
        return new Set(await host.dispatcher.coveredTokenDigests(request))
      },
      tell: (_executionHost, subject, pushed) => {
        void pushed.then((digests) =>
          host.dispatcher.recordMirrorPush({
            subject,
            tokenDigests: digests.flatMap((digest) => digest ?? [])
          })
        )
      }
    }
  })
  const pushesTo = (registrationId: string) =>
    [...host.sends, ...mirror.sends].filter((send) => send.registrationIds.includes(registrationId))
      .length
  return {
    hostSends: async (overrides: Partial<MobileNotificationEvent> = {}) => {
      host.dispatcher.enqueue(notification({ emittedAt: NOW, ...overrides }))
      await flush()
    },
    mirrorSends: async (overrides: Partial<MobileNotificationEvent> = {}) => {
      mirror.dispatcher.enqueue(
        notification({ emittedAt: NOW, executionHost: 'runtime:env-b', ...overrides })
      )
      await flush()
    },
    sharedPhonePushes: () => [pushesTo('b-both'), pushesTo('a-both')],
    mirrorOnlyPhonePushes: () => pushesTo('a-mirror')
  }
}

it('pushes the shared phone once whether the host sends or the mirror asks first', async () => {
  const hostFirst = hosts()
  await hostFirst.hostSends()
  await hostFirst.mirrorSends()
  expect(hostFirst.sharedPhonePushes()).toEqual([1, 0])
  expect(hostFirst.mirrorOnlyPhonePushes()).toBe(1)

  const mirrorFirst = hosts()
  await mirrorFirst.mirrorSends()
  await mirrorFirst.hostSends()
  expect(mirrorFirst.sharedPhonePushes()).toEqual([0, 1])
  expect(mirrorFirst.mirrorOnlyPhonePushes()).toBe(1)
})

it('leaves the shared phone to the mirror when the host does not push it', async () => {
  const hostRulesRefuse = hosts()
  await hostRulesRefuse.hostSends({ desktopAllowed: false })
  await hostRulesRefuse.mirrorSends()
  expect(hostRulesRefuse.sharedPhonePushes()).toEqual([0, 1])

  // A muted workspace never reaches the host's dispatcher.
  const hostNeverSends = hosts()
  await hostNeverSends.mirrorSends()
  expect(hostNeverSends.sharedPhonePushes()).toEqual([0, 1])

  const hostGatewayRefuses = hosts({ hostResults: refused('b-both') })
  await hostGatewayRefuses.hostSends()
  await hostGatewayRefuses.mirrorSends()
  expect(hostGatewayRefuses.sharedPhonePushes()).toEqual([1, 1])
})

it('keeps the host’s copy when the mirror’s push did not go out', async () => {
  const h = hosts({ mirrorResults: refused('a-both') })
  await h.mirrorSends()
  await h.hostSends()
  expect(h.sharedPhonePushes()).toEqual([1, 1])
})

it('collapses a burst across both hosts as the host collapses its own', async () => {
  const h = hosts()
  await h.hostSends()
  await h.mirrorSends()
  await h.hostSends({ notificationId: 'agent:two', emittedAt: NOW + 2_000 })
  await h.mirrorSends({ notificationId: 'agent:two' })
  expect(h.sharedPhonePushes()).toEqual([1, 0])
})

it('pushes every phone when the host cannot answer', async () => {
  const h = hosts({ hostUnreachable: true })
  await h.mirrorSends()
  expect(h.sharedPhonePushes()).toEqual([0, 1])
  expect(h.mirrorOnlyPhonePushes()).toBe(1)
})
