import { createHash } from 'node:crypto'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

export function sessionSearchCandidateAdmission(
  db: SyncDatabase,
  candidate: SessionFileCandidate
): { allowed: boolean; required: boolean; contentRequired: boolean; revision: string } {
  const rows = db
    .prepare(`SELECT c.key,c.selected,c.revision,c.required,c.force_read,c.metadata,p.revision AS group_revision
      FROM temp.search_candidates c LEFT JOIN temp.search_publications p ON p.group_key=c.group_key
      WHERE c.path = ? AND c.agent = ? ORDER BY c.key`)
    .iterate(candidate.file.path, candidate.agent)
  let seen = false
  let allowed = false
  let contentRequired = false
  let required = false
  const hash = createHash('sha256')
  for (const row of rows) {
    seen = true
    allowed ||= row.selected === 1
    required ||= row.selected === 1 && row.required === 1
    contentRequired ||= row.selected === 1 && row.force_read === 1
    hash.update(
      `${row.key}:${row.revision}:${row.group_revision ?? 0}:${row.required}:${row.force_read}:${row.metadata}\0`
    )
  }
  return {
    allowed: !seen || allowed,
    required,
    contentRequired,
    revision: seen ? hash.digest('hex') : ''
  }
}
