import { PUSH_LIMITS, type PushNotificationFilter } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PushDeviceRegistryStore, type PushDeviceUpsert } from './device-registry-store.js'
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

  async function upsertOk(input: PushDeviceUpsert): Promise<string> {
    const result = await devices.upsert(input)
    if (!result.ok) throw new Error(`unexpected upsert refusal: ${result.reason}`)
    return result.registrationId
  }

  function androidDevice(deviceId: string): PushDeviceUpsert {
    return {
      hostFingerprint: OWNER,
      deviceId,
      platform: 'android',
      token: `token-${deviceId}`,
      filter: FILTER
    }
  }

  it('keeps one registration per host and device while replacing the token', async () => {
    const first = await upsertOk({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'ios',
      token: 'a'.repeat(64),
      apnsEnvironment: 'sandbox',
      filter: FILTER
    })
    clock += 1_000
    const second = await upsertOk({
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
    const registrationId = await upsertOk({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'android',
      token: 'token-one',
      filter: FILTER
    })
    await devices.markDead(registrationId)
    expect((await devices.findById(registrationId))?.dead).toBe(true)
    await upsertOk({
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
    const registrationId = await upsertOk({
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
    const owned = await upsertOk({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'android',
      token: 'token-one',
      filter: FILTER
    })
    const foreign = await upsertOk({
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

  it('refuses a new device once the host reaches its registration cap', async () => {
    for (let index = 0; index < PUSH_LIMITS.maxDevicesPerHost; index++) {
      await upsertOk(androidDevice(`device-${index}`))
    }
    expect(await devices.upsert(androidDevice('one-too-many'))).toEqual({
      ok: false,
      reason: 'too_many_devices'
    })
    expect(await devices.list(OWNER)).toHaveLength(PUSH_LIMITS.maxDevicesPerHost)
  })

  it('still lets a capped host re-register a device it already owns', async () => {
    for (let index = 0; index < PUSH_LIMITS.maxDevicesPerHost; index++) {
      await upsertOk(androidDevice(`device-${index}`))
    }
    const rotated = await devices.upsert({ ...androidDevice('device-0'), token: 'rotated-token' })
    expect(rotated.ok).toBe(true)
    expect(await devices.list(OWNER)).toHaveLength(PUSH_LIMITS.maxDevicesPerHost)
  })

  it('frees a slot when a registration is deleted', async () => {
    const first = await upsertOk(androidDevice('device-0'))
    for (let index = 1; index < PUSH_LIMITS.maxDevicesPerHost; index++) {
      await upsertOk(androidDevice(`device-${index}`))
    }
    expect((await devices.upsert(androidDevice('extra'))).ok).toBe(false)
    expect(await devices.deleteOwned(OWNER, first)).toBe(true)
    expect((await devices.upsert(androidDevice('extra'))).ok).toBe(true)
  })

  it('counts the cap per host, not across the whole table', async () => {
    for (let index = 0; index < PUSH_LIMITS.maxDevicesPerHost; index++) {
      await upsertOk(androidDevice(`device-${index}`))
    }
    expect((await devices.upsert(androidDevice('extra'))).ok).toBe(false)
    expect(
      (await devices.upsert({ ...androidDevice('device-0'), hostFingerprint: OTHER })).ok
    ).toBe(true)
  })

  it('never returns more devices than the list response schema accepts', async () => {
    // Straight past the per-host cap, so only the query LIMIT can bound this.
    const rows = PUSH_LIMITS.maxDevicesPerListResponse + 5
    for (let index = 0; index < rows; index++) {
      await database.query(
        `INSERT INTO push_devices (registration_id, host_fingerprint, device_id, platform, token,
         filter_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`reg-${index}`, OWNER, `device-${index}`, 'android', 'token', '{}', clock + index, clock]
      )
    }
    expect(await devices.list(OWNER)).toHaveLength(PUSH_LIMITS.maxDevicesPerListResponse)
  })

  it('separates the same device id registered against two hosts', async () => {
    const first = await upsertOk({
      hostFingerprint: OWNER,
      deviceId: 'shared-device',
      platform: 'ios',
      token: 'a'.repeat(64),
      apnsEnvironment: 'sandbox',
      filter: FILTER
    })
    const second = await upsertOk({
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
