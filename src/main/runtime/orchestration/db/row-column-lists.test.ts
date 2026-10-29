import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import {
  ATTEMPT_OBSERVATION_FACT_COLUMNS,
  DISPATCH_CONTEXT_COLUMNS,
  REMOTE_DISPATCH_ATTACHMENT_COLUMNS,
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
  // Typechecks pin projections to types; this test also pins them to the migrated schema.
  it.each([
    ['runs', RUN_COLUMNS],
    ['tasks', TASK_COLUMNS],
    ['dispatch_contexts', DISPATCH_CONTEXT_COLUMNS],
    ['attempt_observation_facts', ATTEMPT_OBSERVATION_FACT_COLUMNS],
    ['remote_dispatch_attachments', REMOTE_DISPATCH_ATTACHMENT_COLUMNS]
  ])('projects every %s column the migrated schema declares', (table, columns) => {
    db = new OrchestrationDb(':memory:')

    expect([...columns].sort()).toEqual(tableColumns(table))
  })

  // Alias-qualified SQL must still return bare column names for lineage readers.
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
