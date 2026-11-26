import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { PUSH_LIMITS } from '@orca-cloud/push-contract/push-limits'
import { cleanupDurablePushFixtures, fixture } from '../delivery/durable-push-store.test-fixture.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { PushBadgeCountStore } from './push-badge-count-store.js'

afterEach(cleanupDurablePushFixtures)

// The registration schema accepts FCM tokens up to 4,096 characters; random ones don't compress.
const LONG_FCM_TOKEN = randomBytes(3072).toString('base64url')

it('registers a phone whose token is longer than a database index key', async () => {
  const { db, clock } = await fixture()
  const devices = new PushDeviceRegistryStore(db, clock)
  const row = await devices.upsert({
    hostFingerprint: 'host-a',
    deviceId: 'phone',
    platform: 'android',
    token: LONG_FCM_TOKEN
  })
  expect(row.ok).toBe(true)
})

it("sums the phone's own token past the index prefix, then drops to zero once its host lapses", async () => {
  const { db, clock, advance } = await fixture()
  const devices = new PushDeviceRegistryStore(db, clock)
  const badges = new PushBadgeCountStore(db, clock)
  const phoneToken = 'ab'.repeat(300)
  // Shares the first 256 characters, so only the full-token check tells them apart.
  const otherPhoneToken = 'ab'.repeat(128) + 'cd'.repeat(172)
  const register = async (hostFingerprint: string, token: string): Promise<string> => {
    const row = await devices.upsert({
      hostFingerprint,
      deviceId: 'phone',
      platform: 'ios',
      token,
      apnsEnvironment: 'production'
    })
    if (!row.ok) {
      throw new Error('registration failed')
    }
    return row.registrationId
  }
  const phone = await register('host-a', phoneToken)
  await badges.record(phone, 4)
  await badges.record(await register('host-b', otherPhoneToken), 9)
  expect(await badges.total(phoneToken)).toBe(4)
  expect((await badges.carrier(phoneToken))?.registrationId).toBe(phone)
  advance(PUSH_LIMITS.registrationLeaseMs + 1)
  expect(await badges.total(phoneToken)).toBe(0)
})
