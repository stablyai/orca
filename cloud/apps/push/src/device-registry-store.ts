import { randomUUID } from 'node:crypto'
import type {
  ApnsEnvironment,
  PushDeviceSummary,
  PushNotificationFilter,
  PushPlatform
} from '@orca-cloud/push-contract'
import type { PushDatabase, SqlRow } from './push-database.js'

export type PushDeviceRegistration = {
  registrationId: string
  hostFingerprint: string
  deviceId: string
  platform: PushPlatform
  token: string
  apnsEnvironment?: ApnsEnvironment
  dead: boolean
}

export type PushDeviceUpsert = {
  hostFingerprint: string
  deviceId: string
  platform: PushPlatform
  token: string
  apnsEnvironment?: ApnsEnvironment
  filter: PushNotificationFilter
}

function toRegistration(row: SqlRow): PushDeviceRegistration {
  const apnsEnvironment = row.apns_environment
  return {
    registrationId: String(row.registration_id),
    hostFingerprint: String(row.host_fingerprint),
    deviceId: String(row.device_id),
    platform: String(row.platform) as PushPlatform,
    token: String(row.token),
    ...(apnsEnvironment === null || apnsEnvironment === undefined
      ? {}
      : { apnsEnvironment: String(apnsEnvironment) as ApnsEnvironment }),
    dead: row.dead_at !== null && row.dead_at !== undefined
  }
}

export class PushDeviceRegistryStore {
  constructor(
    private readonly database: PushDatabase,
    private readonly now: () => number = Date.now
  ) {}

  // The registration id is stable for a (host, device) pair so a re-registered
  // phone keeps the id the desktop already persisted; only the token rotates.
  async upsert(input: PushDeviceUpsert): Promise<string> {
    const now = this.now()
    const filterJson = JSON.stringify(input.filter)
    return await this.database.transaction(async (transaction) => {
      const [existing] = await transaction.query(
        'SELECT registration_id FROM push_devices WHERE host_fingerprint = ? AND device_id = ?',
        [input.hostFingerprint, input.deviceId]
      )
      if (existing) {
        const registrationId = String(existing.registration_id)
        await transaction.query(
          `UPDATE push_devices
           SET platform = ?, token = ?, apns_environment = ?, filter_json = ?,
               dead_at = NULL, updated_at = ?
           WHERE registration_id = ?`,
          [
            input.platform,
            input.token,
            input.apnsEnvironment ?? null,
            filterJson,
            now,
            registrationId
          ]
        )
        return registrationId
      }
      const registrationId = randomUUID()
      await transaction.query(
        `INSERT INTO push_devices
         (registration_id, host_fingerprint, device_id, platform, token, apns_environment,
          filter_json, dead_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          registrationId,
          input.hostFingerprint,
          input.deviceId,
          input.platform,
          input.token,
          input.apnsEnvironment ?? null,
          filterJson,
          now,
          now
        ]
      )
      return registrationId
    })
  }

  async deleteOwned(hostFingerprint: string, registrationId: string): Promise<boolean> {
    const [result] = await this.database.query(
      'DELETE FROM push_devices WHERE registration_id = ? AND host_fingerprint = ?',
      [registrationId, hostFingerprint]
    )
    return Number(result?.changes ?? 0) > 0
  }

  async list(hostFingerprint: string): Promise<PushDeviceSummary[]> {
    const rows = await this.database.query(
      `SELECT registration_id, device_id, platform, dead_at
       FROM push_devices WHERE host_fingerprint = ? ORDER BY created_at ASC`,
      [hostFingerprint]
    )
    return rows.map((row) => ({
      registrationId: String(row.registration_id),
      deviceId: String(row.device_id),
      platform: String(row.platform) as PushPlatform,
      dead: row.dead_at !== null && row.dead_at !== undefined
    }))
  }

  async findOwned(
    hostFingerprint: string,
    registrationIds: readonly string[]
  ): Promise<Map<string, PushDeviceRegistration>> {
    if (registrationIds.length === 0) return new Map()
    const placeholders = registrationIds.map(() => '?').join(', ')
    const rows = await this.database.query(
      `SELECT registration_id, host_fingerprint, device_id, platform, token, apns_environment,
              dead_at
       FROM push_devices
       WHERE host_fingerprint = ? AND registration_id IN (${placeholders})`,
      [hostFingerprint, ...registrationIds]
    )
    return new Map(
      rows.map((row) => {
        const registration = toRegistration(row)
        return [registration.registrationId, registration]
      })
    )
  }

  async findById(registrationId: string): Promise<PushDeviceRegistration | null> {
    const [row] = await this.database.query(
      `SELECT registration_id, host_fingerprint, device_id, platform, token, apns_environment,
              dead_at
       FROM push_devices WHERE registration_id = ?`,
      [registrationId]
    )
    return row ? toRegistration(row) : null
  }

  async markDead(registrationId: string): Promise<void> {
    await this.database.query(
      'UPDATE push_devices SET dead_at = ?, updated_at = ? WHERE registration_id = ?',
      [this.now(), this.now(), registrationId]
    )
  }
}
