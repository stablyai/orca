import { PUSH_LIMITS } from '@orca-cloud/push-contract/push-limits'
import type { CloudDatabase as PushDatabase } from '@orca-cloud/cloud-database/cloud-database'

type BadgeDevice = { registrationId: string; hostFingerprint: string; token: string }

// Each host sends only its own unread count; only the gateway sees every host a phone is paired with.
export class PushBadgeCountStore {
  constructor(
    private readonly database: PushDatabase,
    private readonly now: () => number = Date.now
  ) {}

  async record(device: BadgeDevice, badge: number): Promise<void> {
    await this.database.query(
      `INSERT INTO push_badge_counts(registration_id, host_fingerprint, token, badge, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(registration_id) DO UPDATE SET
      host_fingerprint = excluded.host_fingerprint, token = excluded.token, badge = excluded.badge, updated_at = excluded.updated_at`,
      [device.registrationId, device.hostFingerprint, device.token, badge, this.now()]
    )
  }

  /** The phone's icon: each host's latest count, over registrations still live on this token. Null when no host has sent one. */
  async total(token: string): Promise<number | null> {
    const rows = await this.database.query(
      `SELECT c.host_fingerprint, c.badge, c.updated_at FROM push_badge_counts c
      JOIN push_devices d ON d.registration_id = c.registration_id
      WHERE c.token = ? AND d.token = ? AND d.dead_at IS NULL`,
      [token, token]
    )
    // A host holding two registrations for one phone (a re-pair) counts once.
    const latest = new Map<string, { badge: number; at: number }>()
    for (const row of rows) {
      const host = String(row.host_fingerprint)
      const at = Number(row.updated_at)
      if ((latest.get(host)?.at ?? -1) < at) {
        latest.set(host, { badge: Number(row.badge), at })
      }
    }
    if (latest.size === 0) return null
    let total = 0
    for (const { badge } of latest.values()) {
      total += badge
    }
    return Math.min(total, PUSH_LIMITS.maxBadgeCount)
  }

  /** Drops a removed registration's count; returns a live one on the same phone to carry the new total. */
  async forget(device: BadgeDevice): Promise<BadgeDevice | null> {
    const [removed] = await this.database.query(
      'SELECT badge FROM push_badge_counts WHERE registration_id = ?',
      [device.registrationId]
    )
    await this.database.query('DELETE FROM push_badge_counts WHERE registration_id = ?', [
      device.registrationId
    ])
    if (!Number(removed?.badge ?? 0)) {
      return null
    }
    const [carrier] = await this.database.query(
      `SELECT d.registration_id, d.host_fingerprint FROM push_badge_counts c
      JOIN push_devices d ON d.registration_id = c.registration_id
      WHERE c.token = ? AND d.token = ? AND d.dead_at IS NULL LIMIT 1`,
      [device.token, device.token]
    )
    return carrier
      ? {
          registrationId: String(carrier.registration_id),
          hostFingerprint: String(carrier.host_fingerprint),
          token: device.token
        }
      : null
  }
}
