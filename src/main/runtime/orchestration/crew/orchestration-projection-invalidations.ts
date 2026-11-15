import type { OrchestrationDb } from '../db/orchestration-db'
import { projectionDebtSchema, markProjectionCandidate } from './orchestration-projection-debt'
import { projectionMutationTriggers } from '../db/projection-mutation-triggers'

const table = 'orchestration_projection'
const pane = (value: string) => `substr(${value}, instr(${value}, ':') + 1)`
const tracked = (key: string) => `INSERT OR IGNORE INTO ${table}_dirty(key)
 SELECT ${key} WHERE ${key} IS NOT NULL AND EXISTS (SELECT 1 FROM ${table}_tracked WHERE key = ${key});`

export function installProjectionInvalidations(db: OrchestrationDb): void {
  const specifications = [
    {
      table: 'dispatch_contexts',
      mark: (r: string) =>
        `${markProjectionCandidate(r)}${[
          `'dispatch:' || ${r}.id`,
          `'task:' || ${r}.task_id`,
          `'handle:' || ${r}.assignee_handle`,
          `'session:' || ${r}.assignee_orca_session_id`
        ]
          .map(tracked)
          .join(' ')}`
    },
    { table: 'tasks', mark: (r: string) => tracked(`'task:' || ${r}.id`) },
    {
      table: 'runs',
      mark: (r: string) =>
        [
          tracked(`'run:' || ${r}.id`),
          tracked(`'bound:' || ${pane(`${r}.coordinator_pane_key`)}`)
        ].join(' ')
    },
    { table: 'coordinator_runs', mark: () => tracked("'legacy'") },
    {
      table: 'worker_dispatches',
      mark: (r: string) =>
        tracked(`'dispatch:' || ${r}.dispatch_id`) +
        tracked(`'task:' || (SELECT task_id FROM dispatch_contexts WHERE id = ${r}.dispatch_id)`)
    },
    {
      table: 'attempt_observation_facts',
      mark: (r: string) => tracked(`'dispatch:' || ${r}.dispatch_id`)
    },
    { table: 'question_threads', mark: (r: string) => tracked(`'dispatch:' || ${r}.dispatch_id`) },
    { table: 'decision_gates', mark: (r: string) => tracked(`'task:' || ${r}.task_id`) },
    {
      table: 'worker_terminal_resources',
      mark: (r: string) =>
        ['owner_dispatch_id', 'origin_dispatch_id']
          .map((key) => tracked(`'dispatch:' || ${r}.${key}`))
          .join(' ') +
        tracked(`'resource-handle:' || ${r}.terminal_handle`) +
        tracked(`'resource-process:' || ${r}.process_incarnation`)
    },
    {
      table: 'messages',
      columns: 'run_id, to_handle, read, delivery_contract, type',
      mark: (r: string) => `INSERT OR IGNORE INTO ${table}_dirty(key)
 SELECT 'dispatch:' || substr(${r}.to_handle, 10)
 WHERE ${r}.type <> 'heartbeat' AND substr(${r}.to_handle, 1, 9) = 'dispatch:'
 AND EXISTS (SELECT 1 FROM ${table}_tracked WHERE key = 'dispatch:' || substr(${r}.to_handle, 10));`
    }
  ]
  db.db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${table}_tracked(key TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS ${table}_dirty(key TEXT PRIMARY KEY) WITHOUT ROWID;
    ${projectionDebtSchema}
    ${projectionMutationTriggers(table, specifications)}`)
}

export function projectionDirtyKeys(db: OrchestrationDb): string[] {
  return db.db
    .prepare(`SELECT key FROM temp.${table}_dirty`)
    .all()
    .flatMap((row) => (typeof row.key === 'string' ? [row.key] : []))
}

export function trackProjectionKey(db: OrchestrationDb, key: string, retained: boolean): void {
  db.db
    .prepare(
      retained
        ? `INSERT OR IGNORE INTO temp.${table}_tracked VALUES (?)`
        : `DELETE FROM temp.${table}_tracked WHERE key = ?`
    )
    .run(key)
}
