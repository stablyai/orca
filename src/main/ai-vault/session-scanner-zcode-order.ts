import { columnExists } from '../opencode-usage/schema-helpers'
import type SyncDatabase from '../sqlite/sync-database'

export function zcodeTranscriptOrder(
  db: SyncDatabase,
  agent: 'opencode' | 'zcode',
  table: 'message' | 'part',
  alias: 'm' | 'p',
  direction: 'ASC' | 'DESC'
): string {
  const sequenced = agent === 'zcode' && columnExists(db, table, 'sequence')
  const sequence = sequenced
    ? `${alias}.sequence IS NULL ${direction}, ${alias}.sequence ${direction}, `
    : ''
  // ZCode orders imported/forked transcripts by sequence, with legacy NULL rows last.
  const tieBreaker = table === 'message' ? (sequenced ? 'rowid' : 'id') : sequenced ? 'id' : 'rowid'
  return `${sequence}${alias}.time_created ${direction}, ${alias}.${tieBreaker} ${direction}`
}
