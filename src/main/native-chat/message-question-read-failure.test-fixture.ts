import { vi } from 'vitest'
import type Database from '../sqlite/sync-database'

/** Target reads/updates/COMMIT remain real; only the subsequent full source read fails. */
export function failQuestionReadAfterTargetCommit(db: Database.Database, target: string) {
  let updated = false
  let failedReads = 0
  const prepare = db.prepare.bind(db)
  const wrapped = new WeakSet<object>()
  const restorations: (() => void)[] = []
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (wrapped.has(statement)) {
      return statement
    }
    wrapped.add(statement)
    if (sql.startsWith('UPDATE message_question_occurrences SET record_json')) {
      const run = statement.run.bind(statement)
      const update = vi.spyOn(statement, 'run').mockImplementation((...args) => {
        const result = run(...args)
        if (args[1] === target) {
          updated = true
        }
        return result
      })
      restorations.push(() => update.mockRestore())
    }
    if (
      sql ===
      'SELECT occurrence_id, record_json FROM message_question_occurrences WHERE source_id = ?'
    ) {
      const all = statement.all.bind(statement)
      const read = vi.spyOn(statement, 'all').mockImplementation((...args) => {
        if (updated && !db.isTransaction) {
          failedReads++
          throw new Error('postcommit source read failed')
        }
        return all(...args)
      })
      restorations.push(() => read.mockRestore())
    }
    return statement
  })
  return {
    failedReads: () => failedReads,
    restore: () => {
      spy.mockRestore()
      for (const restore of restorations) {
        restore()
      }
    }
  }
}
