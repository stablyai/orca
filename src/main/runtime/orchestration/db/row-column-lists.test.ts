import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import {
  DISPATCH_CONTEXT_COLUMNS,
  RUN_COLUMNS,
  selectColumns,
  TASK_COLUMNS
} from './row-column-lists'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function tableColumns(table: string): string[] {
  const rows = (db as OrchestrationDb).db.pragma(`table_info(${table})`) as { name: string }[]
  return rows.map((row) => row.name).sort()
}

describe('row column lists', () => {
  // Why: these lists replaced `SELECT *`, so a column added to the schema without being listed here
  // would silently stop being read. tsc pins list↔type; this pins list↔schema.
  it.each([
    ['runs', RUN_COLUMNS],
    ['tasks', TASK_COLUMNS],
    ['dispatch_contexts', DISPATCH_CONTEXT_COLUMNS]
  ])('projects every %s column the migrated schema declares', (table, columns) => {
    db = new OrchestrationDb(':memory:')

    expect([...columns].sort()).toEqual(tableColumns(table))
  })

  it('qualifies each column when the statement joins under an alias', () => {
    expect(selectColumns(['id', 'run_id'])).toBe('id, run_id')
    expect(selectColumns(['id', 'run_id'], 't')).toBe('t.id, t.run_id')
  })

  // Why: an alias-qualified projection must key the returned row by the bare column name, exactly as
  // the `t.*` it replaced did — otherwise every lineage consumer reads undefined.
  it('returns bare column names for an alias-qualified projection', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'demo',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: 'tab_c:leaf_c'
    })
    const task = db.createTask({ spec: 'work', runId: run.id })

    const row = db.db
      .prepare(`SELECT ${selectColumns(TASK_COLUMNS, 't')} FROM tasks t WHERE t.id = ?`)
      .get(task.id) as Record<string, unknown>

    expect(Object.keys(row).sort()).toEqual([...TASK_COLUMNS].sort())
  })
})
