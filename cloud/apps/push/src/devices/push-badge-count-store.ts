import { PUSH_LIMITS } from '@orca-cloud/push-contract/push-limits'
import type { CloudDatabase as PushDatabase } from '@orca-cloud/cloud-database/cloud-database'
import { PUSH_TOKEN_INDEX_CHARS } from '../database/push-schema.js'

// Matches the push_devices_token prefix index, then the whole token.
const BY_TOKEN = `substr(d.token, 1, ${PUSH_TOKEN_INDEX_CHARS}) = ? AND d.token = ?`
const tokenParams = (token: string) => [token.slice(0, PUSH_TOKEN_INDEX_CHARS), token]

// Each host sends only its own unread count; only the gateway sees every host a phone is paired with.
export class PushBadgeCountStore {
  constructor(
    private readonly database: PushDatabase,
    private readonly now: () => number = Date.now
  ) {}

  async record(registrationId: string, badge: number): Promise<void> {
    await this.database.query(
      `INSERT INTO push_badge_counts(registration_id, badge, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(registration_id) DO UPDATE SET badge = excluded.badge, updated_at = excluded.updated_at`,
      [registrationId, badge, this.now()]
    )
  }

  /** The phone's icon: each host's latest count over its live registrations. Null when no host has ever sent one. */
  async total(token: string): Promise<number | null> {
    const rows = await this.database.query(
      `SELECT d.host_fingerprint, d.updated_at AS renewed_at, c.badge, c.updated_at FROM push_devices d
      JOIN push_badge_counts c ON c.registration_id = d.registration_id
      WHERE ${BY_TOKEN} AND d.dead_at IS NULL`,
      tokenParams(token)
    )
    if (rows.length === 0) {
      return null
    }
    // A host the phone stopped renewing (removed while offline, or unused past the lease) drops out,
    // and the icon still gets a number, so a lapsed host's count can't linger on it.
    // A host holding two registrations for one phone (a re-pair) counts once.
    const latest = new Map<string, { badge: number; at: number }>()
    for (const row of rows) {
      if (Number(row.renewed_at) <= this.leaseStart()) {
        continue
      }
      const host = String(row.host_fingerprint)
      const at = Number(row.updated_at)
      if ((latest.get(host)?.at ?? -1) < at) {
        latest.set(host, { badge: Number(row.badge), at })
      }
    }
    let total = 0
    for (const { badge } of latest.values()) {
      total += badge
    }
    return Math.min(total, PUSH_LIMITS.maxBadgeCount)
  }

  async shareOf(registrationId: string): Promise<number> {
    const [row] = await this.database.query(
      'SELECT badge FROM push_badge_counts WHERE registration_id = ?',
      [registrationId]
    )
    return Number(row?.badge ?? 0)
  }

  /** Any live registration of this phone, from any host, to carry a new total. */
  async carrier(token: string): Promise<{ registrationId: string; hostFingerprint: string } | null> {
    const [row] = await this.database.query(
      `SELECT d.registration_id, d.host_fingerprint FROM push_devices d
      WHERE ${BY_TOKEN} AND d.platform = 'ios' AND d.dead_at IS NULL AND d.updated_at > ? LIMIT 1`,
      [...tokenParams(token), this.leaseStart()]
    )
    return row
      ? {
          registrationId: String(row.registration_id),
          hostFingerprint: String(row.host_fingerprint)
        }
      : null
  }

  private leaseStart(): number {
    return this.now() - PUSH_LIMITS.registrationLeaseMs
  }
}
