// Serialized admission for the GLOBAL durable candidate-store budget (§0.2).
//
// THE RACE THIS EXISTS TO CLOSE. Two derivations can each read a SUM showing
// headroom before either attaches its store — a check-then-act race that
// overcommits the budget. Reading `used + reserved` inside BEGIN IMMEDIATE makes
// the second competitor observe the first's HELD reservation and be refused.
//
// NO GIT OR FILESYSTEM WORK RUNS INSIDE THESE TRANSACTIONS. The durable copy
// happens strictly between two closed transactions, consistent with the lane's
// standing rule that admission CAS and subprocess execution never overlap.
//
// A HELD RESERVATION IS RELEASED ONLY BY ITS OWNER. `expires_at_ms` is
// diagnostic + startup-recovery evidence ONLY: releasing on elapsed time would
// free budget while a promotion is still writing bytes — a silent overcommit
// precisely when the cap matters most. A long-running promotion whose TTL has
// passed STILL reserves its bytes.
import type Database from '../sqlite/sync-database'
import { CANDIDATE_STORE_LIMITS, STORE_RESERVATION_TTL_MS } from '../../shared/audited-commit-types'

export type StoreReservationResult =
  | { ok: true; reservationId: string }
  | { ok: false; reasonCode: 'quota_exceeded' | 'lock_contended' }

function generateReservationId(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `sres_${hex}`
}

/**
 * The global durable footprint currently charged: attached stores plus every
 * in-flight reservation.
 *
 * Callers must invoke this INSIDE a transaction for it to be authoritative;
 * outside one it is advisory (used by code-audit admission to refuse early).
 */
export function readChargedBytes(db: Database.Database): number {
  const used = db
    .prepare(
      `SELECT COALESCE(SUM(store_bytes), 0) AS total FROM audited_candidates
        WHERE status = 'current' AND store_bytes IS NOT NULL`
    )
    .get() as { total: number }
  const reserved = db
    .prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS total FROM audited_store_reservations
        WHERE state = 'held'`
    )
    .get() as { total: number }
  return used.total + reserved.total
}

/** Whether `bytes` would fit right now. Advisory outside a transaction. */
export function wouldFitGlobalBudget(db: Database.Database, bytes: number): boolean {
  return readChargedBytes(db) + bytes <= CANDIDATE_STORE_LIMITS.globalDurableBytes
}

/**
 * Reserves global budget for a measured footprint.
 *
 * Short, subprocess-free, and serialized by BEGIN IMMEDIATE — the whole point.
 */
export function reserveStoreBytes(
  db: Database.Database,
  args: { candidateId: string; bytes: number },
  nowMs: number
): StoreReservationResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const charged = readChargedBytes(db)
    if (charged + args.bytes > CANDIDATE_STORE_LIMITS.globalDurableBytes) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'quota_exceeded' }
    }
    const reservationId = generateReservationId()
    try {
      db.prepare(
        `INSERT INTO audited_store_reservations
           (id, candidate_id, bytes, state, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, 'held', ?, ?)`
      ).run(reservationId, args.candidateId, args.bytes, nowMs, nowMs + STORE_RESERVATION_TTL_MS)
    } catch {
      // The partial unique index rejected a concurrent duplicate for this
      // candidate — the last line of defense against double-charging.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }
    db.exec('COMMIT')
    return { ok: true, reservationId }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * THE OWNING FINALIZER — the only in-process path out of `held`.
 *
 * Called on both success and failure. On success the caller also writes
 * `store_bytes`, in the SAME transaction, so the charge moves from `reserved` to
 * `used` atomically and is never double-counted or momentarily uncounted.
 */
export function releaseReservation(
  db: Database.Database,
  reservationId: string,
  options?: { attachedBytes?: number; candidateId?: string }
): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const released = db
      .prepare(
        `UPDATE audited_store_reservations SET state = 'released'
          WHERE id = ? AND state = 'held'`
      )
      .run(reservationId)
    if (released.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }
    if (options?.attachedBytes !== undefined && options.candidateId) {
      db.prepare(`UPDATE audited_candidates SET store_bytes = ? WHERE id = ?`).run(
        options.attachedBytes,
        options.candidateId
      )
    }
    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * STARTUP-ONLY reclamation of abandoned reservations.
 *
 * Sound ONLY at startup, and then unconditionally: any promotion that could have
 * owned a `held` row belonged to a previous process, and that process is gone by
 * definition — no prior-process promotion can still be running. This is a
 * PROCESS-LIFETIME judgement, not a timestamp or PID one, matching the lane's
 * standing rule that PIDs are never used for liveness (PID reuse makes "is it
 * alive" unanswerable across a restart).
 *
 * Must run before any new reservation can be taken.
 */
export function expireAbandonedReservationsOnStartup(db: Database.Database): number {
  const result = db
    .prepare(`UPDATE audited_store_reservations SET state = 'expired' WHERE state = 'held'`)
    .run()
  return Number(result.changes)
}
