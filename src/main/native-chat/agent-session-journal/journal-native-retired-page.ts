import type Database from '../../sqlite/sync-database'

export function sweepJournalRetiredPage(
  db: Database.Database,
  after: number
): { more: boolean; position: number } {
  let position = after
  const candidates = db
    .prepare(`SELECT a.generation FROM journal_outcome_generations a LEFT JOIN journal_outcome_epochs e
      ON e.session_id = a.session_id AND e.epoch = a.epoch AND e.generation = a.generation
      WHERE e.session_id IS NULL AND a.generation > ? ORDER BY a.generation LIMIT 32`)
    .all(after)
  for (const { generation } of candidates) {
    if (typeof generation !== 'number') {
      continue
    }
    position = generation
    const removed = db
      .prepare(`DELETE FROM journal_outcomes WHERE rowid IN (
        SELECT rowid FROM journal_outcomes WHERE generation = ? LIMIT 32)`)
      .run(generation)
    if (removed.changes === 0) {
      db.prepare('DELETE FROM journal_outcome_generations WHERE generation = ?').run(generation)
      continue
    }
    // One bounded data page per transaction, even with many retired generations. The next page
    // resumes at this generation, so it never rescans the live ones before it.
    position = generation - 1
    return { more: true, position }
  }
  if (candidates.length === 32) {
    return { more: true, position }
  }
  position = 0
  return { more: false, position }
}
