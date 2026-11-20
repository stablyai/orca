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
  const insert = db.prepare(`INSERT INTO agent_session_attachment_claims(upload_id,session_id,
    claimed_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
  for (const claim of claims) {
    insert.run(claim.upload_id!, sessionId, claim.claimed_at!)
  }
}
