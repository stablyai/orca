// Lifecycle and reclamation for the durable candidate store (§0.3).
//
// THE ORDERING IS FIXED, AND IT IS THE INVERSE OF THE INTUITIVE ONE.
// Filesystem deletion is NOT transactional: an rm can fail (locked file,
// permissions, antivirus, a vanished volume) after the database has moved on. If
// accounting release were tied to deletion SUCCEEDING, one stuck directory would
// permanently consume global budget with no way to reclaim it.
//
// So:
//   1. inside the SAME SQLite transaction that makes the store ineligible, set
//      store_bytes = NULL and store_expires_at_ms = NULL;
//   2. COMMIT;
//   3. only then attempt rm, synchronously before returning;
//   4. a failure is logged inertly and changes no outcome — the row already reads
//      NULL, so the budget is free regardless, and the directory becomes an
//      orphan for the startup sweep.
//
// Because the global total is derived as SUM(store_bytes) WHERE status='current',
// nulling the column IS the release; there is no second counter to keep in step.
//
// Undeleted bytes still exist on disk until the sweep reclaims them. Per §0.1
// that bounds retention and discoverability — it is never a claim of erasure.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../sqlite/sync-database'
import { CANDIDATE_STORE_RETENTION_TTL_MS } from '../../shared/audited-commit-types'
import {
  CANDIDATE_STORE_DIR_PATTERN,
  getCandidateStoreRoot,
  removeCandidateStoreDir
} from './audited-candidate-object-store'
import { expireAbandonedReservationsOnStartup } from './audited-candidate-store-reservation'

/**
 * Releases a candidate's store accounting INSIDE the caller's open transaction.
 *
 * The caller must already be in a transaction that is performing the state change
 * making the store ineligible (terminal write, TTL expiry, or supersession), so
 * accounting release is atomic with its cause: there is no window in which a task
 * is terminal but still charged.
 */
export function clearStoreAccountingInTransaction(
  db: Database.Database,
  candidateId: string
): void {
  db.prepare(
    `UPDATE audited_candidates SET store_bytes = NULL, store_expires_at_ms = NULL WHERE id = ?`
  ).run(candidateId)
}

/**
 * Releases accounting for every candidate of a task, then deletes the
 * directories. Used by terminal transitions (committed/cancelled/landed).
 *
 * The transaction closes BEFORE any filesystem work, per the ordering above.
 */
export function releaseTaskStoresAndDelete(
  db: Database.Database,
  taskId: string,
  userDataPath: string
): { released: number; deletionFailures: number } {
  const candidateIds: string[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db
      .prepare(`SELECT id FROM audited_candidates WHERE task_id = ? AND store_bytes IS NOT NULL`)
      .all(taskId) as { id: string }[]
    for (const row of rows) {
      clearStoreAccountingInTransaction(db, row.id)
      candidateIds.push(row.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  // Filesystem work strictly after the commit, synchronously before returning.
  let deletionFailures = 0
  for (const candidateId of candidateIds) {
    if (!removeCandidateStoreDir(userDataPath, candidateId)) {
      deletionFailures += 1
    }
  }
  return { released: candidateIds.length, deletionFailures }
}

export type StoreSweepResult = {
  expiredReservations: number
  releasedCandidates: number
  removedDirectories: number
  deletionFailures: number
}

/**
 * The startup sweep — the ONLY path that expires a `held` reservation.
 *
 * Nothing time-based runs while the app is live. This must execute before any new
 * reservation can be taken, which is what makes unconditional expiry sound here
 * and unsound anywhere else.
 */
export function sweepCandidateStoresOnStartup(
  db: Database.Database,
  userDataPath: string,
  nowMs: number
): StoreSweepResult {
  const expiredReservations = expireAbandonedReservationsOnStartup(db)

  // Release accounting for rows that are no longer eligible: superseded (already
  // excluded from the total by status, but cleared so the columns mean exactly
  // one thing), terminal tasks, and TTL lapses.
  const releasedIds: string[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db
      .prepare(
        `SELECT c.id AS id
           FROM audited_candidates c
           JOIN audited_tasks t ON t.id = c.task_id
          WHERE c.store_bytes IS NOT NULL
            AND (c.status != 'current'
                 OR t.state IN ('cancelled','committed','landed')
                 OR (c.store_expires_at_ms IS NOT NULL AND c.store_expires_at_ms <= ?))`
      )
      .all(nowMs) as { id: string }[]
    for (const row of rows) {
      clearStoreAccountingInTransaction(db, row.id)
      releasedIds.push(row.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  // Now reconcile the filesystem. A directory is removable when no candidate row
  // still owns it (store_bytes IS NULL covers every case released above).
  let removedDirectories = 0
  let deletionFailures = 0
  const root = getCandidateStoreRoot(userDataPath)
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return {
      expiredReservations,
      releasedCandidates: releasedIds.length,
      removedDirectories,
      deletionFailures
    }
  }

  for (const name of entries) {
    // Anything that could not have been produced by this module is left strictly
    // alone, mirroring CANDIDATE_RUN_DIR_PATTERN's sweep rule.
    if (!CANDIDATE_STORE_DIR_PATTERN.test(name)) {
      continue
    }
    const owner = db
      .prepare(
        `SELECT store_bytes FROM audited_candidates WHERE id = ? AND store_bytes IS NOT NULL`
      )
      .get(name) as { store_bytes: number } | undefined
    if (owner) {
      continue
    }
    if (removeCandidateStoreDir(userDataPath, name)) {
      removedDirectories += 1
    } else {
      deletionFailures += 1
    }
  }

  // Recompute surviving rows' store_bytes from actual on-disk size, so a crashed
  // write cannot leave the derived total permanently inflated.
  reconcileSurvivingStoreBytes(db, root)

  return {
    expiredReservations,
    releasedCandidates: releasedIds.length,
    removedDirectories,
    deletionFailures
  }
}

function reconcileSurvivingStoreBytes(db: Database.Database, root: string): void {
  const rows = db
    .prepare(`SELECT id, store_bytes FROM audited_candidates WHERE store_bytes IS NOT NULL`)
    .all() as { id: string; store_bytes: number }[]
  for (const row of rows) {
    const actual = safeDirectorySize(join(root, row.id))
    if (actual === null) {
      // The directory is gone but the row still claims bytes — release the
      // charge rather than let it linger.
      db.prepare(
        `UPDATE audited_candidates SET store_bytes = NULL, store_expires_at_ms = NULL WHERE id = ?`
      ).run(row.id)
      continue
    }
    if (actual !== row.store_bytes) {
      db.prepare(`UPDATE audited_candidates SET store_bytes = ? WHERE id = ?`).run(actual, row.id)
    }
  }
}

function safeDirectorySize(dir: string): number | null {
  try {
    statSync(dir)
  } catch {
    return null
  }
  let total = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      try {
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile()) {
          total += statSync(full).size
        }
      } catch {
        // Vanished mid-walk; the total stays a lower bound.
      }
    }
  }
  try {
    walk(dir)
  } catch {
    return null
  }
  return total
}

export function candidateStoreExpiryAt(nowMs: number): number {
  return nowMs + CANDIDATE_STORE_RETENTION_TTL_MS
}
