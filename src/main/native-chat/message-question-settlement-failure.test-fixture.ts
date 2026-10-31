import { vi } from 'vitest'
import type Database from '../sqlite/sync-database'

/** Only occurrence settlement fails; canonical transactions and provider actions remain real. */
export function failQuestionSettlement(
  db: Database.Database,
  target: string,
  mode: 'q2' | 'update' | 'commit'
) {
  let updates = false
  let failures = 0
  let rejectedInserts = 0
  const cleanups: (() => void)[] = []
  if (mode !== 'commit') {
    db.exec(
      mode === 'q2'
        ? `CREATE TEMP TRIGGER fail_epoch_questions BEFORE INSERT ON message_question_occurrences
         WHEN NEW.occurrence_id <> '${target}' BEGIN SELECT RAISE(ABORT, 'Q2 INSERT unavailable'); END`
        : `CREATE TEMP TRIGGER fail_epoch_questions BEFORE UPDATE ON message_question_occurrences
         WHEN OLD.occurrence_id = '${target}' BEGIN SELECT RAISE(ABORT, 'Q1 UPDATE unavailable'); END`
    )
    cleanups.push(() => db.exec('DROP TRIGGER fail_epoch_questions'))
  }
  if (mode !== 'update') {
    const prepare = db.prepare.bind(db)
    const wrapped = new WeakSet<object>()
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      const updateTarget = sql.startsWith('UPDATE message_question_occurrences SET record_json')
      const upsertTarget = sql.startsWith(
        'INSERT INTO message_question_occurrences (occurrence_id, source_id, record_json)'
      )
      if ((updateTarget || upsertTarget) && !wrapped.has(statement)) {
        wrapped.add(statement)
        const run = statement.run.bind(statement)
        const update = vi.spyOn(statement, 'run').mockImplementation((...args) => {
          try {
            const result = run(...args)
            if (mode === 'commit') {
              const id = updateTarget ? args[1] : args[0]
              const record = JSON.parse(String(updateTarget ? args[0] : args[2]))
              if (id === target && record.resolution.state !== 'pending') {
                updates = true
              }
            }
            return result
          } catch (error) {
            if (
              mode === 'q2' &&
              upsertTarget &&
              error instanceof Error &&
              error.message === 'Q2 INSERT unavailable'
            ) {
              rejectedInserts++
            }
            throw error
          }
        })
        cleanups.push(() => update.mockRestore())
      }
      return statement
    })
    cleanups.push(() => spy.mockRestore())
  }
  if (mode === 'commit') {
    const exec = db.exec.bind(db)
    const commit = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' && updates) {
        updates = false
        failures++
        throw new Error('Q1 COMMIT unavailable')
      }
      return exec(sql)
    })
    cleanups.push(() => commit.mockRestore())
  }
  return {
    failedCommits: () => failures,
    rejectedInserts: () => rejectedInserts,
    restore: () =>
      cleanups
        .splice(0)
        .toReversed()
        .forEach((cleanup) => cleanup())
  }
}
