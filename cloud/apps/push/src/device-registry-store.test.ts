import type { PushNotificationFilter } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { openInMemoryPushDatabase, type PushDatabase } from './push-database.js'

const OWNER = 'abcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcba'
const FILTER: PushNotificationFilter = {
  sources: ['agent-task-complete'],
  agentStates: ['needs-input']
}

describe('push device registry store', () => {
  let database: PushDatabase
  let clock = 1_700_000_000_000
  let devices: PushDeviceRegistryStore

  beforeEach(async () => {
    database = await openInMemoryPushDatabase()
    clock = 1_700_000_000_000
    devices = new PushDeviceRegistryStore(database, () => clock)
  })

  afterEach(async () => {
    await database.close()
  })

  it('keeps one registration per host and device while replacing the token', async () => {
    const first = await devices.upsert({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'ios',
      token: 'a'.repeat(64),
      apnsEnvironment: 'sandbox',
      filter: FILTER
    })
    clock += 1_000
    const second = await devices.upsert({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'ios',
      token: 'b'.repeat(64),
      apnsEnvironment: 'production',
      filter: FILTER
    })
    expect(second).toBe(first)
    const registration = await devices.findById(first)
    expect(registration).toMatchObject({
      token: 'b'.repeat(64),
      apnsEnvironment: 'production',
      dead: false
    })
    expect(await devices.list(OWNER)).toHaveLength(1)
  })

  it('revives a registration that a re-registered token replaces', async () => {
    const registrationId = await devices.upsert({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'android',
      token: 'token-one',
      filter: FILTER
    })
    await devices.markDead(registrationId)
    expect((await devices.findById(registrationId))?.dead).toBe(true)
    await devices.upsert({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'android',
      token: 'token-two',
      filter: FILTER
    })
    expect(await devices.findById(registrationId)).toMatchObject({
      token: 'token-two',
      dead: false
    })
  })

  it('lets only the owning host delete a registration', async () => {
    const registrationId = await devices.upsert({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'android',
      token: 'token-one',
      filter: FILTER
    })
    expect(await devices.deleteOwned(OTHER, registrationId)).toBe(false)
    expect(await devices.findById(registrationId)).not.toBeNull()
    expect(await devices.deleteOwned(OWNER, registrationId)).toBe(true)
    expect(await devices.findById(registrationId)).toBeNull()
  })

  it('scopes lookups and listings to the owning host', async () => {
    const owned = await devices.upsert({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'android',
      token: 'token-one',
      filter: FILTER
    })
    const foreign = await devices.upsert({
      hostFingerprint: OTHER,
      deviceId: 'device-2',
      platform: 'android',
      token: 'token-two',
      filter: FILTER
    })
    const found = await devices.findOwned(OWNER, [owned, foreign])
    expect([...found.keys()]).toEqual([owned])
    expect(await devices.list(OTHER)).toEqual([
      { registrationId: foreign, deviceId: 'device-2', platform: 'android', dead: false }
    ])
    expect(await devices.findOwned(OWNER, [])).toEqual(new Map())
  })

  it('separates the same device id registered against two hosts', async () => {
    const first = await devices.upsert({
      hostFingerprint: OWNER,
      deviceId: 'shared-device',
      platform: 'ios',
      token: 'a'.repeat(64),
      apnsEnvironment: 'sandbox',
      filter: FILTER
    })
    const second = await devices.upsert({
      hostFingerprint: OTHER,
      deviceId: 'shared-device',
      platform: 'ios',
      token: 'c'.repeat(64),
      apnsEnvironment: 'sandbox',
      filter: FILTER
    })
    expect(first).not.toBe(second)
  })
})
