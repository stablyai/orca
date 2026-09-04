import { randomUUID } from 'node:crypto'
import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import type { PushDatabase } from './push-database.js'

const QUOTA_LOCK_PREFIX = 'orca-push-send-quota:'
const ROLLING_HOUR_MS = 60 * 60 * 1000
const ROLLING_DAY_MS = 24 * ROLLING_HOUR_MS

export type PushQuotaDecision = 'allowed' | 'rate_limited'

export class PushSendQuota {
  constructor(
    private readonly database: PushDatabase,
    private readonly now: () => number = Date.now
  ) {}

  // One transaction is not enough on its own: PostgreSQL reads at READ
  // COMMITTED, so concurrent reserves would each see the same under-quota count
  // and all be admitted. The host lock serializes them. The registration count
  // rides the same lock because a registration belongs to exactly one host.
  async reserve(hostFingerprint: string, registrationId: string): Promise<PushQuotaDecision> {
    const now = this.now()
    return await this.database.transaction<PushQuotaDecision>(async (transaction) => {
      await transaction.lockQuotaScope(`${QUOTA_LOCK_PREFIX}${hostFingerprint}`)
      const [hostRow] = await transaction.query(
        'SELECT COUNT(*) AS sends FROM push_send_log WHERE host_fingerprint = ? AND sent_at > ?',
        [hostFingerprint, now - ROLLING_HOUR_MS]
      )
      if (Number(hostRow?.sends ?? 0) >= PUSH_LIMITS.hostSendsPerRollingHour) return 'rate_limited'
      const [registrationRow] = await transaction.query(
        'SELECT COUNT(*) AS sends FROM push_send_log WHERE registration_id = ? AND sent_at > ?',
        [registrationId, now - ROLLING_DAY_MS]
      )
      if (
        Number(registrationRow?.sends ?? 0) >= PUSH_LIMITS.registrationSendsPerRollingDay
      ) {
        return 'rate_limited'
      }
      await transaction.query(
        `INSERT INTO push_send_log (send_id, host_fingerprint, registration_id, sent_at)
         VALUES (?, ?, ?, ?)`,
        [randomUUID(), hostFingerprint, registrationId, now]
      )
      return 'allowed'
    })
  }

  async prune(): Promise<number> {
    const [result] = await this.database.query('DELETE FROM push_send_log WHERE sent_at < ?', [
      this.now() - PUSH_LIMITS.sendLogRetentionMs
    ])
    return Number(result?.changes ?? 0)
  }
}
