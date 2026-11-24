import { createHash, randomUUID } from 'node:crypto'
import type { CloudDatabase } from '@orca-cloud/cloud-database/cloud-database'
import type { LiveActivityBootstrap, LiveActivityContribution, LiveActivitySend } from '@orca-cloud/push-contract/live-activity-messages'
import { LIVE_ACTIVITY_FRESH_MS, liveActivityOverviewContent, liveActivityOverviewIdentity } from './live-activity-overview-content.js'

const LIFETIME_MS = 8 * 60 * 60_000
const HEARTBEAT_MS = 5 * 60_000
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export type OverviewClaim = { id: string; lease: string; revision: number; identity: string; nextAt: number; push: LiveActivitySend }

export class LiveActivityOverviewStore {
  constructor(private readonly database: CloudDatabase, private readonly now: () => number = Date.now) {}

  async register(owner: string, input: LiveActivityBootstrap): Promise<boolean> {
    const scopes = JSON.stringify([...new Set(input.scopes)].sort())
    return this.database.transaction(async (tx) => {
      await tx.lockQuotaScope(`live-overview-owner:${owner}`)
      await tx.lockQuotaScope(`live-overview:${input.overviewId}`)
      const [existing] = await tx.query('SELECT * FROM push_live_overviews WHERE overview_id = ?', [input.overviewId])
      if (existing) {
        if (existing.control_hash !== digest(input.controlKey) || existing.scopes !== scopes || Number(existing.show_names) !== Number(input.showNames) || Number(existing.discovery_complete) !== Number(input.discoveryComplete) || Number(existing.expires_at) <= this.now()) return false
        if (input.revision < Number(existing.control_revision)) return true
        if (input.revision === Number(existing.control_revision)) return existing.token === input.token && existing.apns_environment === input.apnsEnvironment
        if (existing.token !== input.token || existing.apns_environment !== input.apnsEnvironment) {
          await tx.query('UPDATE push_live_overviews SET owner_fingerprint = ?, control_revision = ?, token = ?, apns_environment = ?, revision = revision + 1, next_at = ?, sent_identity = NULL WHERE overview_id = ?', [owner, input.revision, input.token, input.apnsEnvironment, this.now(), input.overviewId])
        } else {
          await tx.query('UPDATE push_live_overviews SET owner_fingerprint = ?, control_revision = ? WHERE overview_id = ?', [owner, input.revision, input.overviewId])
        }
        return true
      }
      const [count] = await tx.query('SELECT COUNT(*) AS count FROM push_live_overviews WHERE owner_fingerprint = ? AND expires_at > ?', [owner, this.now()])
      if (Number(count?.count) >= 128) return false
      await tx.query('INSERT INTO push_live_overviews(overview_id, owner_fingerprint, control_hash, control_revision, show_names, discovery_complete, token, apns_environment, scopes, created_at, expires_at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [input.overviewId, owner, digest(input.controlKey), input.revision, Number(input.showNames), Number(input.discoveryComplete), input.token, input.apnsEnvironment, scopes, this.now(), this.now() + LIFETIME_MS, this.now()])
      return true
    })
  }

  async contribute(owner: string, input: LiveActivityContribution): Promise<'sent' | 'dead' | 'error'> {
    return this.database.transaction(async (tx) => {
      await tx.lockQuotaScope(`live-overview:${input.overviewId}`)
      const [overview] = await tx.query('SELECT * FROM push_live_overviews WHERE overview_id = ?', [input.overviewId])
      if (!overview) return 'dead'
      if (Number(overview.expires_at) <= this.now()) return 'dead'
      const scopeId = digest(input.scopeKey)
      if (!(JSON.parse(String(overview.scopes)) as string[]).includes(scopeId)) return 'error'
      const [previous] = await tx.query('SELECT * FROM push_live_contributions WHERE overview_id = ? AND scope_id = ?', [input.overviewId, scopeId])
      if (previous && previous.owner_fingerprint !== owner) return 'error'
      if (previous && Number(previous.sequence) >= input.sequence) return 'sent'
      await tx.query(`INSERT INTO push_live_contributions(overview_id, scope_id, owner_fingerprint, sequence, content, received_at, retired) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(overview_id, scope_id) DO UPDATE SET sequence = excluded.sequence, content = excluded.content, received_at = excluded.received_at, retired = excluded.retired`, [input.overviewId, scopeId, owner, input.sequence, JSON.stringify(input.content), this.now(), input.event === 'end' ? 1 : 0])
      await tx.query('UPDATE push_live_overviews SET revision = revision + 1, next_at = ? WHERE overview_id = ?', [this.now(), input.overviewId])
      return 'sent'
    })
  }

  async claim(): Promise<OverviewClaim | null> {
    return this.database.transaction(async (tx) => {
      const now = this.now()
      const candidates = await tx.query('SELECT overview_id FROM push_live_overviews WHERE next_at <= ? AND lease_until <= ? ORDER BY next_at LIMIT 16', [now, now])
      for (const candidate of candidates) {
        const id = String(candidate.overview_id)
        if (!(await tx.tryLockScope(`live-overview:${id}`))) continue
        const [overview] = await tx.query('SELECT * FROM push_live_overviews WHERE overview_id = ?', [id])
        if (!overview || Number(overview.next_at) > now || Number(overview.lease_until) > now) continue
        const rows = await tx.query('SELECT * FROM push_live_contributions WHERE overview_id = ?', [id])
        const scopes = JSON.parse(String(overview.scopes)) as string[]
        const content = liveActivityOverviewContent(scopes, rows, Number(overview.created_at), now, Number(overview.discovery_complete) === 1)
        if (!Number(overview.show_names)) for (const session of content.sessions) session.title = ''
        const ended = Number(overview.expires_at) <= now
        if (ended) { content.state = 'unavailable'; content.complete = false }
        const identity = liveActivityOverviewIdentity(content)
        const nextAt = Math.min(Number(overview.expires_at), now + HEARTBEAT_MS, ...rows.filter((row) => !Number(row.retired) && Number(row.received_at) + LIVE_ACTIVITY_FRESH_MS > now).map((row) => Number(row.received_at) + LIVE_ACTIVITY_FRESH_MS))
        if (!ended && overview.sent_identity === identity && Number(overview.sent_at) + HEARTBEAT_MS > now) {
          await tx.query('UPDATE push_live_overviews SET next_at = ? WHERE overview_id = ?', [Math.min(nextAt, Number(overview.sent_at) + HEARTBEAT_MS), id])
          continue
        }
        const timestamp = Math.floor(now / 1000)
        if (timestamp <= Number(overview.timestamp)) {
          await tx.query('UPDATE push_live_overviews SET next_at = ? WHERE overview_id = ?', [(Number(overview.timestamp) + 1) * 1000, id])
          continue
        }
        const lease = randomUUID()
        await tx.query('UPDATE push_live_overviews SET lease_id = ?, lease_until = ?, timestamp = ? WHERE overview_id = ?', [lease, now + 30_000, timestamp, id])
        return { id, lease, revision: Number(overview.revision), identity, nextAt,
          push: { token: String(overview.token), apnsEnvironment: String(overview.apns_environment) as 'sandbox' | 'production', timestamp, event: ended ? 'end' : 'update', content } }
      }
      return null
    })
  }

  async finish(claim: OverviewClaim, status: 'sent' | 'dead' | 'error'): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.lockQuotaScope(`live-overview:${claim.id}`)
      const [current] = await tx.query('SELECT * FROM push_live_overviews WHERE overview_id = ? AND lease_id = ?', [claim.id, claim.lease])
      if (!current) return
      const sameDestination = current.token === claim.push.token && current.apns_environment === claim.push.apnsEnvironment
      if (sameDestination && (status === 'dead' || (status === 'sent' && claim.push.event === 'end'))) {
        await this.remove(tx, claim.id)
        return
      }
      const sent = status === 'sent' && sameDestination
      const changed = Number(current.revision) !== claim.revision
      const nextAt = changed ? this.now() : status === 'error' ? this.now() + 5000 : claim.nextAt
      await tx.query('UPDATE push_live_overviews SET lease_id = NULL, lease_until = 0, next_at = ?, sent_identity = ?, sent_at = ? WHERE overview_id = ?', [Math.max(nextAt, (claim.push.timestamp + 1) * 1000), sent ? claim.identity : current.sent_identity, sent ? this.now() : current.sent_at, claim.id])
    })
  }

  async prune(): Promise<void> {
    await this.database.transaction(async (tx) => {
      const rows = await tx.query('SELECT overview_id FROM push_live_overviews WHERE expires_at < ? LIMIT 100', [this.now() - 24 * 60 * 60_000])
      for (const row of rows) {
        const id = String(row.overview_id)
        if (await tx.tryLockScope(`live-overview:${id}`)) await this.remove(tx, id)
      }
    })
  }

  private async remove(tx: CloudDatabase, id: string): Promise<void> {
    await tx.query('DELETE FROM push_live_contributions WHERE overview_id = ?', [id])
    await tx.query('DELETE FROM push_live_overviews WHERE overview_id = ?', [id])
  }
}
