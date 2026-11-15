// POST /__admin/verify on the host's own store: the director's check for phone credentials that
// exist only on the edge. Must answer correctly and change nothing.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { RelayCredentialStore, hashCredential } from '../../relay/src/credentials/credential-store'
import type { DeviceRow, VerifyBody } from '../src/admin'
import { VerifyBodySchema } from '../src/admin'
import { ObjectStore } from '../src/object-store'
import { verifyCredential } from '../src/verify'
import { nodeObjectSql } from './object-sqlite-fake'

const CELL = 'edge'
const HOST = 'edgecohorthost01'
const USER = 'user-1'
const GOOD = 'A'.repeat(43)
const ROTATED = 'C'.repeat(43)

function objectStore(): { store: ObjectStore; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  const sql = nodeObjectSql(db)
  let open = false
  const store = new ObjectStore(
    sql,
    async (operation) => {
      if (open) { throw new Error('nested storage transaction') }
      open = true
      db.exec('BEGIN')
      try {
        const result = await operation()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        open = false
      }
    },
    CELL
  )
  return { store, db }
}

function device(id: string, token: string, extra: Partial<DeviceRow> = {}): DeviceRow {
  return {
    user_id: USER,
    relay_host_id: HOST,
    relay_device_id: id,
    current_hash: hashCredential(token),
    current_version: 1,
    current_expires_at: Date.now() + 86_400_000,
    grace_hash: null,
    grace_version: null,
    grace_expires_at: null,
    revoked_at: null,
    updated_at: Date.now(),
    ...extra
  }
}

// Every row of every table, so a test can prove the check wrote nothing.
function snapshot(db: DatabaseSync): string {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]))
}

const body = (token: string, kind: VerifyBody['kind'] = 'resume'): VerifyBody => ({ relayHostId: HOST, kind, tokenHash: hashCredential(token) })

describe('edge verify (director phone credential check)', () => {
  it('verifies a device the edge holds (paired here, or its grace token after a rotation)', async () => {
    const { store } = objectStore()
    await store.applyAssignment({ userId: USER, relayHostId: HOST, cellId: CELL, assignmentEpoch: 3, devices: [] })
    const sql = store.database
    await sql.query(
      `INSERT INTO relay_devices (user_id, relay_host_id, relay_device_id, current_hash, current_version, current_expires_at,
         grace_hash, grace_version, grace_expires_at, revoked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Object.values(device('phone-edge', ROTATED, { grace_hash: hashCredential(GOOD), grace_version: 1, current_version: 2, grace_expires_at: Date.now() + 60_000 }))
    )
    expect(await verifyCredential(store, CELL, body(ROTATED))).toEqual({ outcome: 'verified', userId: USER, relayDeviceId: 'phone-edge', assignmentEpoch: 3 })
    expect(await verifyCredential(store, CELL, body(GOOD))).toMatchObject({ outcome: 'verified', relayDeviceId: 'phone-edge' })
  })

  it('refuses unknown, revoked and expired credentials', async () => {
    const { store } = objectStore()
    await store.applyAssignment({
      userId: USER,
      relayHostId: HOST,
      cellId: CELL,
      assignmentEpoch: 1,
      devices: [device('phone-revoked', GOOD, { revoked_at: Date.now() - 1 }), device('phone-expired', ROTATED, { current_expires_at: Date.now() - 1 })]
    })
    expect(await verifyCredential(store, CELL, body('B'.repeat(43)))).toEqual({ outcome: 'none' })
    expect(await verifyCredential(store, CELL, body(GOOD))).toEqual({ outcome: 'none' })
    expect(await verifyCredential(store, CELL, body(ROTATED))).toEqual({ outcome: 'none' })
  })

  it('verifies an invite created on the edge, and only as an invite', async () => {
    const { store } = objectStore()
    await store.applyAssignment({ userId: USER, relayHostId: HOST, cellId: CELL, assignmentEpoch: 2, devices: [] })
    const invite = await new RelayCredentialStore(store.database).createInvite({ userId: USER, relayHostId: HOST }, 'phone-new')
    expect(await verifyCredential(store, CELL, body(invite.inviteToken, 'invite'))).toEqual({
      outcome: 'verified',
      userId: USER,
      relayDeviceId: 'phone-new',
      assignmentEpoch: 2
    })
    expect(await verifyCredential(store, CELL, body(invite.inviteToken, 'resume'))).toEqual({ outcome: 'none' })
  })

  it('answers not_here when the object does not hold the host here (never placed, moved away, frozen)', async () => {
    const { store } = objectStore()
    expect(await verifyCredential(store, CELL, body(GOOD))).toEqual({ outcome: 'not_here' })
    await store.applyAssignment({ userId: USER, relayHostId: HOST, cellId: CELL, assignmentEpoch: 1, devices: [device('phone-a', GOOD)] })
    expect(await verifyCredential(store, CELL, { ...body(GOOD), relayHostId: 'otherhost0000001' })).toEqual({ outcome: 'not_here' })
    store.freezeForExport()
    expect(await verifyCredential(store, CELL, body(GOOD))).toEqual({ outcome: 'not_here' })
    await store.applyAssignment({ userId: USER, relayHostId: HOST, cellId: 'us-c1', assignmentEpoch: 2 })
    expect(await verifyCredential(store, CELL, body(GOOD))).toEqual({ outcome: 'not_here' })
  })

  it('changes nothing in the object, whatever the answer', async () => {
    const { store, db } = objectStore()
    await store.applyAssignment({ userId: USER, relayHostId: HOST, cellId: CELL, assignmentEpoch: 1, devices: [device('phone-a', GOOD)] })
    const invite = await new RelayCredentialStore(store.database).createInvite({ userId: USER, relayHostId: HOST }, 'phone-b')
    const before = snapshot(db)
    await verifyCredential(store, CELL, body(GOOD))
    await verifyCredential(store, CELL, body('B'.repeat(43)))
    await verifyCredential(store, CELL, body(invite.inviteToken, 'invite'))
    expect(snapshot(db)).toBe(before)
    expect(store.frozen()).toBe(false)
  })

  it('accepts only a hash-shaped body, never a raw token or extra fields', () => {
    expect(VerifyBodySchema.safeParse(body(GOOD)).success).toBe(true)
    expect(VerifyBodySchema.safeParse({ ...body(GOOD), tokenHash: `${hashCredential(GOOD)}=` }).success).toBe(false)
    expect(VerifyBodySchema.safeParse({ ...body(GOOD), token: GOOD }).success).toBe(false)
    expect(VerifyBodySchema.safeParse({ ...body(GOOD), kind: 'device' }).success).toBe(false)
  })
})
