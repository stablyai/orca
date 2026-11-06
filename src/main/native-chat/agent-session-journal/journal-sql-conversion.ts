import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { restoreJournal } from './journal-open'
import { failLoadOnUnloadableJournal } from './journal-open-failure'
import { JournalOutcomeItemProvenance } from './journal-outcome-item-provenance'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { exportJournalControlState } from './journal-sql-control-export'
import { journalInputAcceptance } from './journal-input-provenance'
import { publishJournalSqlGeneration, readJournalLogWatermark } from './journal-sql-meta'

/**
 * Converts one chat's saved log into a ready projection generation, once: today's restore reads
 * the log exactly as an open does, and its result becomes the persisted state. Items the restore
 * admitted unchanged keep pointing at their saved outcome record instead of a second copy.
 * Returns null for a chat with nothing to convert; its first open founds the epoch.
 */
export function convertJournalSqlProjection(
  db: Database.Database,
  sessionId: string
): string | null {
  if (!db.isTransaction) {
    throw new Error('journal projection conversion requires its transaction')
  }
  const provenance = new JournalOutcomeItemProvenance()
  const loaded = restoreJournal(db, sessionId, { admitItem: provenance.capture })
  if (!loaded || (!loaded.newer && !loaded.damage && loaded.state.lastSequence === 0)) {
    return null
  }
  failLoadOnUnloadableJournal(sessionId, loaded)
  const watermark = readJournalLogWatermark(db, sessionId)
  if (watermark?.epoch !== loaded.state.epoch) {
    throw new Error('journal log changed during projection conversion')
  }
  const generation = randomUUID()
  const scope = new JournalSqlScope(db, sessionId, generation)
  const exported = new JournalSqlReducer(scope, loaded.state.epoch, (id) =>
    journalInputAcceptance(db, sessionId, id)
  )
  exported.context.bulkLoad(() => {
    exportJournalControlState(loaded.state, exported.state, { items: true })
    exported.flush()
  })
  pointUnchangedItemsAtOutcomes(scope, loaded.state.items, provenance)
  publishJournalSqlGeneration(db, sessionId, generation, '')
  return generation
}

function pointUnchangedItemsAtOutcomes(
  scope: JournalSqlScope,
  items: JournalSqlConversionItems,
  provenance: JournalOutcomeItemProvenance
): void {
  const point = scope.db.prepare(`UPDATE journal_proj_item_versions
    SET outcome_generation=?, outcome_seq=?, inline_json=NULL
    WHERE session_id=? AND generation=? AND entry_key=? AND incarnation=?`)
  const size = scope.db.prepare(`UPDATE journal_proj_items SET byte_size=?
    WHERE session_id=? AND generation=? AND entry_key=?`)
  for (const row of scope.db
    .prepare(`SELECT entry_key, incarnation FROM journal_proj_items
    WHERE session_id=? AND generation=?`)
    .all(...scope.prefix)) {
    const key = String(row.entry_key)
    const item = items.get(JSON.parse(key) as string)
    const source = item && provenance.source(item, key)
    if (!source) {
      continue
    }
    point.run(source.generation, source.sequence, ...scope.prefix, key, row.incarnation)
    size.run(source.bytes, ...scope.prefix, key)
  }
}

type JournalSqlConversionItems = {
  get: (itemId: string) => Parameters<JournalOutcomeItemProvenance['source']>[0] | undefined
}
