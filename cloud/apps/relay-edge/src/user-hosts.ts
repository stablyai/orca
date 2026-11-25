// Erasure index (docs/relay-edge/research/director-removal.md §3.4, decision 2026-11-17): one
// Durable Object per user (idFromName(userId)) listing the relay hosts whose objects hold that
// user's data, so account erasure can find hosts that have no relay_assignments row (placed by the
// edge-native director). Host objects add and remove themselves (host-relay-director.ts, dark);
// the erasure job and the backfill reach it through signed admin ops (index.ts).
// The index holds host ids and timestamps only, never credentials.
import { DurableObject } from 'cloudflare:workers'
import { ADMIN_JTI_KEY, admitJti, type AdminReplayGuard, type ReplayRefusal, type SeenJtis } from './admin-jti'
import type { Env } from './env'

const HOSTS_DDL = `CREATE TABLE IF NOT EXISTS user_hosts (
  relay_host_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
)`

export type IndexedHost = { relayHostId: string; firstSeen: number; lastSeen: number }

export class UserHosts extends DurableObject<Env> {
  // An index nobody wrote to has no table: reads answer before any schema is created.
  private hasTable(): boolean {
    return this.ctx.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_hosts'`).toArray().length > 0
  }

  // Idempotent: a repeat keeps first_seen and moves last_seen forward.
  async add(relayHostId: string, now = Date.now()): Promise<void> {
    this.ctx.storage.sql.exec(HOSTS_DDL)
    this.ctx.storage.sql.exec(
      `INSERT INTO user_hosts (relay_host_id, first_seen, last_seen) VALUES (?, ?, ?)
       ON CONFLICT (relay_host_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
      relayHostId,
      now,
      now
    )
  }

  // Idempotent: removing a host the index does not hold changes nothing (and creates no storage).
  async remove(relayHostId: string): Promise<void> {
    if (!this.hasTable()) { return }
    this.ctx.storage.sql.exec(`DELETE FROM user_hosts WHERE relay_host_id = ?`, relayHostId)
  }

  async list(): Promise<IndexedHost[]> {
    if (!this.hasTable()) { return [] }
    return this.ctx.storage.sql
      .exec(`SELECT relay_host_id, first_seen, last_seen FROM user_hosts ORDER BY relay_host_id`)
      .toArray()
      .map((row) => ({ relayHostId: String(row.relay_host_id), firstSeen: Number(row.first_seen), lastSeen: Number(row.last_seen) }))
  }

  // Every byte of the index goes (its recorded admin jtis too).
  async erase(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }

  // ---------------- signed admin ops (the Worker verified the request) ----------------

  // Read-only. An empty index answers before the jti is recorded, so a lookup of an unknown user
  // gives the object no storage; a copy of that token can only read the same empty list.
  async adminList(replay?: AdminReplayGuard | null): Promise<ReplayRefusal | { outcome: 'listed'; relayHostIds: string[] }> {
    const hosts = await this.list()
    if (hosts.length > 0) {
      const refused = await this.claimAdminJti(replay)
      if (refused) { return refused }
    }
    return { outcome: 'listed', relayHostIds: hosts.map((h) => h.relayHostId) }
  }

  // The backfill (§4 step 4): one relay_assignments row at a time.
  async adminIndex(relayHostId: string, replay?: AdminReplayGuard | null): Promise<ReplayRefusal | { outcome: 'indexed' }> {
    const refused = await this.claimAdminJti(replay)
    if (refused) { return refused }
    await this.add(relayHostId)
    return { outcome: 'indexed' }
  }

  // The erasure job's last step, after every listed host is erased. Wipes the recorded jtis with
  // everything else: a copy of the token then finds an empty index, and erasing it changes nothing.
  async adminErase(replay?: AdminReplayGuard | null): Promise<ReplayRefusal | { outcome: 'erased' }> {
    const refused = await this.claimAdminJti(replay)
    if (refused) { return refused }
    await this.erase()
    return { outcome: 'erased' }
  }

  private async claimAdminJti(replay: AdminReplayGuard | null | undefined): Promise<ReplayRefusal | null> {
    if (!replay) { return null }
    const { outcome, seen } = admitJti(await this.ctx.storage.get<SeenJtis>(ADMIN_JTI_KEY), replay, Date.now())
    if (outcome !== 'fresh') { return { outcome } }
    await this.ctx.storage.put(ADMIN_JTI_KEY, seen)
    return null
  }
}
