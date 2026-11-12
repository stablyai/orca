import { PUSH_LIMITS } from '@orca-cloud/push-contract/push-limits'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PushDeviceRegistryStore, type PushDeviceUpsert } from './device-registry-store.js'
import { openInMemoryPushDatabase } from '../database/push-database.js'
import type { CloudDatabase as PushDatabase } from '@orca-cloud/cloud-database/cloud-database'

const OWNER = 'abcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcba'

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
      token: `token-${deviceId}`
    }
  }

  it('keeps one registration per host and device while replacing the token', async () => {
    const first = await upsertOk({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'ios',
      token: 'a'.repeat(64),
      apnsEnvironment: 'sandbox'
    })
    clock += 1_000
    const second = await upsertOk({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'ios',
      token: 'b'.repeat(64),
      apnsEnvironment: 'production'
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
      token: 'token-one'
    })
    await devices.markDead((await devices.findById(registrationId))!)
    expect((await devices.findById(registrationId))?.dead).toBe(true)
    await upsertOk({
      hostFingerprint: OWNER,
      deviceId: 'device-1',
      platform: 'android',
      token: 'token-two'
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
      token: 'token-one'
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
      token: 'token-one'
    })
    const foreign = await upsertOk({
      hostFingerprint: OTHER,
      deviceId: 'device-2',
      platform: 'android',
      token: 'token-two'
    })
    const found = await devices.findOwned(OWNER, [owned, foreign])
    expect([...found.keys()]).toEqual([owned])
    expect(await devices.list(OTHER)).toEqual([
      { registrationId: foreign, deviceId: 'device-2', platform: 'android', dead: false }
    ])
    expect(await devices.findOwned(OWNER, [])).toEqual(new Map())
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
})
