import { afterEach, expect, it } from 'vitest'
import type { PushDatabase } from './push-database.js'
import { DELIVERY_LEASE_MS, DurablePushStore } from './durable-push-store.js'
import {
  cleanupDurablePushFixtures,
  durablePushTestDatabaseUrl,
  fixture,
  notification,
  pauseAfter,
  within
} from './durable-push-store.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

const LEASE_SQL = 'UPDATE push_delivery_batches SET lease_token'

// The previous revision's claim statements, in order, with a hook between its candidate scan and re-read.
function previousRevisionClaim(
  db: PushDatabase,
  clock: () => number,
  afterCandidate: () => Promise<void>
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.lockQuotaScope('push-worker-claim')
    const now = clock()
    const [candidate] = await tx.query(
      `SELECT * FROM push_delivery_batches WHERE state = 'pending' AND lease_until <= ? AND expires_at > ? AND due_at <= ? AND NOT EXISTS (SELECT 1 FROM push_delivery_batches busy WHERE busy.registration_id = push_delivery_batches.registration_id AND busy.lease_until > ?)
      ORDER BY due_at, created_at, batch_id LIMIT 1`,
      [now, now, now, now]
    )
    await afterCandidate()
    if (!candidate) return null
    await tx.lockQuotaScope(`push-events:${String(candidate.host_fingerprint)}`)
    const [row] = await tx.query('SELECT * FROM push_delivery_batches WHERE batch_id = ?', [
      candidate.batch_id
    ])
    if (!row || row.state !== 'pending' || Number(row.expires_at) <= now) return null
    await tx.query(
      'UPDATE push_delivery_batches SET lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE batch_id = ?',
      ['previous', now + DELIVERY_LEASE_MS, row.batch_id]
    )
    return 'previous'
  })
}

it.skipIf(!durablePushTestDatabaseUrl)(
  'keeps a previous-revision claim from re-leasing a delivery this revision leased',
  async () => {
    const { db, store, clock } = await fixture({ ownDatabase: true })
    await store.accept('host', 'phone', notification(1))
    const paused = pauseAfter(db, LEASE_SQL)
    const current = new DurablePushStore(paused.wrapped, clock).claim()
    await paused.atCandidate
    let committed!: () => void
    const currentCommitted = new Promise<void>((resolve) => (committed = resolve))
    const previous = previousRevisionClaim(db, clock, () => currentCommitted)
    // Room for the previous claim to scan while this revision's lease is still uncommitted.
    await new Promise((resolve) => setTimeout(resolve, 200))
    paused.release()
    const leased = await current
    committed()
    expect(await previous).toBeNull()
    const [row] = await db.query('SELECT lease_token FROM push_delivery_batches')
    expect(leased?.lease).toBeTruthy()
    expect(row?.lease_token).toBe(leased?.lease)
  }
)

it.skipIf(!durablePushTestDatabaseUrl)(
  'yields to a previous-revision claim that already holds the claim lock',
  async () => {
    const { db, store, clock } = await fixture({ ownDatabase: true })
    await store.accept('host', 'phone', notification(1))
    let scanned!: () => void
    const atCandidate = new Promise<void>((resolve) => (scanned = resolve))
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const previous = previousRevisionClaim(db, clock, async () => {
      scanned()
      await released
    })
    await atCandidate
    try {
      expect(await within(store.claim(), 2_000)).toBeNull()
    } finally {
      release()
    }
    expect(await previous).toBe('previous')
    expect(await store.claim()).toBeNull()
  }
)
