// Phase 8 §0.2 — serialized global admission for the durable candidate store.
//
// The two defects these tests exist to prevent:
//   1. an elapsed expires_at_ms releasing a reservation while promotion is still
//      writing (a silent overcommit exactly when the cap matters);
//   2. two concurrent derivations both observing the same headroom.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CANDIDATE_STORE_LIMITS } from '../../shared/audited-commit-types'
import { createAuditedWorkflowTables } from './audited-task-schema'
import {
  expireAbandonedReservationsOnStartup,
  readChargedBytes,
  releaseReservation,
  reserveStoreBytes,
  wouldFitGlobalBudget
} from './audited-candidate-store-reservation'
import Database from '../sqlite/sync-database'

function seedCandidate(db: Database.Database, id: string, storeBytes: number | null): void {
  db.prepare(
    `INSERT INTO audited_candidates
       (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name,
        store_bytes, created_at_ms)
     VALUES (?, 'task1', 'run1', 0, 'current', ?, ?, 'b', ?, 1)`
  ).run(id, 'a'.repeat(40), 'b'.repeat(40), storeBytes)
}

describe('candidate store reservation', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
  })

  afterEach(() => {
    db.close()
  })

  it('charges attached stores plus held reservations', () => {
    seedCandidate(db, 'cand_a', 100)
    expect(readChargedBytes(db)).toBe(100)

    const reserved = reserveStoreBytes(db, { candidateId: 'cand_b', bytes: 50 }, 1000)
    expect(reserved.ok).toBe(true)
    expect(readChargedBytes(db)).toBe(150)
  })

  // 10g8 — two concurrent derivations, one slot left.
  it('refuses the second of two competitors when only one fits', () => {
    const cap = CANDIDATE_STORE_LIMITS.globalDurableBytes
    const half = Math.floor(cap * 0.6)

    const first = reserveStoreBytes(db, { candidateId: 'cand_1', bytes: half }, 1000)
    const second = reserveStoreBytes(db, { candidateId: 'cand_2', bytes: half }, 1000)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reasonCode).toBe('quota_exceeded')
    }
    // The invariant: charged never exceeds the cap at any observation point.
    expect(readChargedBytes(db)).toBeLessThanOrEqual(cap)
  })

  it('frees the budget for a retry once the winner releases', () => {
    const cap = CANDIDATE_STORE_LIMITS.globalDurableBytes
    const half = Math.floor(cap * 0.6)
    const first = reserveStoreBytes(db, { candidateId: 'cand_1', bytes: half }, 1000)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }

    expect(reserveStoreBytes(db, { candidateId: 'cand_2', bytes: half }, 1000).ok).toBe(false)

    // Owner releases WITHOUT attaching (the failure path).
    expect(releaseReservation(db, first.reservationId)).toBe(true)
    expect(readChargedBytes(db)).toBe(0)
    expect(reserveStoreBytes(db, { candidateId: 'cand_2', bytes: half }, 2000).ok).toBe(true)
  })

  // 10g9a — THE CRITICAL ONE. An elapsed TTL must NOT release a live reservation.
  it('keeps reserving bytes for a long-running promotion whose TTL has passed', () => {
    const cap = CANDIDATE_STORE_LIMITS.globalDurableBytes
    const half = Math.floor(cap * 0.6)

    const inFlight = reserveStoreBytes(db, { candidateId: 'cand_slow', bytes: half }, 1000)
    expect(inFlight.ok).toBe(true)

    // Force the reservation to look long-expired. Nothing in-process may act on
    // this: the promotion it belongs to could still be writing bytes.
    db.prepare(`UPDATE audited_store_reservations SET expires_at_ms = 1 WHERE state = 'held'`).run()

    // A competitor arriving MUCH later must still be refused.
    const laterMs = 10_000_000_000
    const competitor = reserveStoreBytes(db, { candidateId: 'cand_other', bytes: half }, laterMs)
    expect(competitor.ok).toBe(false)
    if (!competitor.ok) {
      expect(competitor.reasonCode).toBe('quota_exceeded')
    }

    // The in-flight reservation is untouched and still charged.
    const held = db
      .prepare(`SELECT state FROM audited_store_reservations WHERE candidate_id = 'cand_slow'`)
      .get() as { state: string }
    expect(held.state).toBe('held')
    expect(readChargedBytes(db)).toBe(half)
  })

  // 10g9b — only the owner releases in-process.
  it('is not released by any lifecycle event other than its owner', () => {
    const reserved = reserveStoreBytes(db, { candidateId: 'cand_x', bytes: 100 }, 1000)
    expect(reserved.ok).toBe(true)

    // Simulate unrelated activity: supersession and a terminal task write.
    db.prepare(`UPDATE audited_candidates SET status = 'superseded'`).run()
    seedCandidate(db, 'cand_y', null)

    const state = db
      .prepare(`SELECT state FROM audited_store_reservations WHERE candidate_id = 'cand_x'`)
      .get() as { state: string }
    expect(state.state).toBe('held')
  })

  it('attaches store_bytes in the same transaction that releases', () => {
    seedCandidate(db, 'cand_z', null)
    const reserved = reserveStoreBytes(db, { candidateId: 'cand_z', bytes: 250 }, 1000)
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) {
      return
    }

    expect(
      releaseReservation(db, reserved.reservationId, {
        attachedBytes: 250,
        candidateId: 'cand_z'
      })
    ).toBe(true)

    // The charge moved from `reserved` to `used` without a gap.
    expect(readChargedBytes(db)).toBe(250)
    const row = db
      .prepare(`SELECT store_bytes FROM audited_candidates WHERE id = 'cand_z'`)
      .get() as {
      store_bytes: number
    }
    expect(row.store_bytes).toBe(250)
  })

  it('rejects a duplicate held reservation for one candidate', () => {
    expect(reserveStoreBytes(db, { candidateId: 'cand_dup', bytes: 10 }, 1000).ok).toBe(true)
    const second = reserveStoreBytes(db, { candidateId: 'cand_dup', bytes: 10 }, 1000)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reasonCode).toBe('lock_contended')
    }
  })

  // 10g9 — startup reclamation, keyed to process lifetime rather than a clock.
  it('expires abandoned reservations only at startup, freeing their budget', () => {
    const reserved = reserveStoreBytes(db, { candidateId: 'cand_crash', bytes: 400 }, 1000)
    expect(reserved.ok).toBe(true)
    expect(readChargedBytes(db)).toBe(400)

    const expired = expireAbandonedReservationsOnStartup(db)
    expect(expired).toBe(1)
    expect(readChargedBytes(db)).toBe(0)

    // Idempotent: a second sweep finds nothing.
    expect(expireAbandonedReservationsOnStartup(db)).toBe(0)
  })

  it('reports fit against the cap', () => {
    expect(wouldFitGlobalBudget(db, CANDIDATE_STORE_LIMITS.globalDurableBytes)).toBe(true)
    expect(wouldFitGlobalBudget(db, CANDIDATE_STORE_LIMITS.globalDurableBytes + 1)).toBe(false)
  })
})
