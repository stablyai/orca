import { createHash } from 'node:crypto'
import { runJournalTransaction } from './journal-database'
import { isSqliteCorruption, isSqliteStorageFailure } from '../../../sqlite/sqlite-read-failure'
import { journalLegacyFailureKey, readJournalLegacyFailure } from './journal-legacy-source'
import type Database from '../../../sqlite/sync-database'
import type { Claim } from './journal-legacy-adoption'

export function missingJournalLegacyClaims(
  db: Database.Database,
  sessionId: string,
  claims: readonly Claim[]
): Claim[] {
  const held = db.prepare(
    'SELECT 1 FROM agent_session_attachment_claims WHERE upload_id=? AND session_id=?'
  )
  return claims.filter((claim) => !held.get(claim.upload_id!, sessionId))
}

/** Uploads the older Orca attached stay claimed, so the sweeper never removes them. */
export function insertJournalLegacyClaims(
  db: Database.Database,
  sessionId: string,
  claims: readonly Claim[]
): void {
  const insert = prepareJournalLegacyClaimsInsert(db)
  for (const claim of claims) {
    insert.run(claim.upload_id!, sessionId, claim.claimed_at!)
  }
}

/** Only a refused set needs a durable identity; custody checks already supplied these rows. */
export function journalLegacyClaimsFingerprint(claims: readonly Claim[]): string {
  const hash = createHash('sha256')
  const keys = claims
    .map((claim) =>
      JSON.stringify([
        typeof claim.upload_id,
        String(claim.upload_id),
        typeof claim.claimed_at,
        String(claim.claimed_at)
      ])
    )
    .sort()
  for (const key of keys) {
    hash.update(key)
  }
  return `v1:${hash.digest('hex')}`
}

export function clearJournalLegacyClaimFailure(db: Database.Database, sessionId: string): void {
  const failure = readJournalLegacyFailure(db, sessionId)
  if (!failure?.claims) {
    return
  }
  const key = journalLegacyFailureKey(sessionId)
  if (failure.revision === null) {
    db.prepare('DELETE FROM agent_session_store_meta WHERE key=?').run(key)
  } else {
    const { claims: _claims, ...history } = failure
    db.prepare('UPDATE agent_session_store_meta SET value=? WHERE key=?').run(
      JSON.stringify(history),
      key
    )
  }
}

/** Normal adoption stays atomic; only its failure salvages valid original custody claim by claim. */
export function recoverJournalLegacyClaims(
  db: Database.Database,
  sessionId: string,
  claims: readonly Claim[],
  record: (refused: string | null) => void
): void {
  const missing = missingJournalLegacyClaims(db, sessionId, claims)
  const finish = () => {
    const refused = missingJournalLegacyClaims(db, sessionId, claims)
    record(refused.length ? journalLegacyClaimsFingerprint(refused) : null)
  }
  let rolledBack = false
  try {
    runJournalTransaction(db, () => {
      for (const claim of missing) {
        db.exec('SAVEPOINT journal_legacy_claim')
        try {
          insertJournalLegacyClaims(db, sessionId, [claim])
        } catch (error) {
          if (isSqliteStorageFailure(error) || isSqliteCorruption(error)) {
            throw error
          }
          if (!db.isTransaction) {
            rolledBack = true
            throw error
          }
          db.exec('ROLLBACK TO journal_legacy_claim')
        }
        db.exec('RELEASE journal_legacy_claim')
      }
      finish()
    })
  } catch (error) {
    if (
      !rolledBack ||
      isSqliteStorageFailure(error) ||
      isSqliteCorruption(error) ||
      db.isTransaction
    ) {
      throw error
    }
    // A transaction-ending trigger defeats savepoints; each remaining attempt owns its rollback.
    for (const claim of missing) {
      try {
        runJournalTransaction(db, () => {
          insertJournalLegacyClaims(db, sessionId, [claim])
          record('pending')
        })
      } catch (claimError) {
        if (
          isSqliteStorageFailure(claimError) ||
          isSqliteCorruption(claimError) ||
          db.isTransaction
        ) {
          throw claimError
        }
      }
    }
    runJournalTransaction(db, finish)
  }
}

export function prepareJournalLegacyClaimsInsert(db: Database.Database): Database.Statement {
  return db.prepare(`INSERT INTO agent_session_attachment_claims(upload_id,session_id,
    claimed_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
}
