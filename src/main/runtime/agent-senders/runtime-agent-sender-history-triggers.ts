import { z } from 'zod'
import { projectionMutationTriggers } from '../orchestration/db/projection-mutation-triggers'
import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { tolerant } from './agent-sender-row-decoding'

const dirtyRow = z.object({ kind: z.enum(['pane', 'dispatch']), key: z.string() })

/** Per table: the columns whose change can change a sender, and the pane and Dispatch keys a
 *  row's old and new values name, so a write marks exactly the history it can affect. */
const HISTORY_TRIGGERS = [
  {
    table: 'dispatch_contexts',
    columns:
      'status, assignee_handle, assignee_pane_key, assignee_orca_session_id, follow_up_of_dispatch_id, process_incarnation, host_scope, launch_token_hash',
    panes: ['assignee_pane_key'],
    // Its own row, and its parent's follow-up lookup.
    dispatches: ['id', 'follow_up_of_dispatch_id']
  },
  {
    table: 'worker_terminal_resources',
    columns:
      'owner_dispatch_id, origin_dispatch_id, pane_key, terminal_handle, prior_owner_dispatch_ids, ownership_state, release_state, retained_reason, process_incarnation, host_scope',
    panes: ['pane_key'],
    dispatches: ['owner_dispatch_id', 'origin_dispatch_id'],
    priors: true
  },
  {
    table: 'worker_dispatches',
    columns: 'start_options',
    panes: [],
    dispatches: ['dispatch_id']
  },
  {
    table: 'remote_dispatch_attachments',
    columns: 'state, pane_key, home_peer_fingerprint, process_incarnation',
    panes: ['pane_key'],
    dispatches: []
  }
] as const

function markDirty(row: 'NEW' | 'OLD', trigger: (typeof HISTORY_TRIGGERS)[number]): string {
  const keys = [
    ...trigger.panes.map((column) => `SELECT 'pane' AS kind, ${row}.${column} AS key`),
    ...trigger.dispatches.map((column) => `SELECT 'dispatch' AS kind, ${row}.${column} AS key`),
    ...('priors' in trigger
      ? [
          `SELECT 'dispatch', value FROM json_each(CASE WHEN json_valid(${row}.prior_owner_dispatch_ids) THEN ${row}.prior_owner_dispatch_ids ELSE '[]' END)`
        ]
      : [])
  ]
  return `INSERT OR IGNORE INTO temp.agent_sender_dirty (kind, key)
  SELECT kind, key FROM (${keys.join(' UNION ALL ')}) AS changed WHERE key IS NOT NULL AND EXISTS (
    SELECT 1 FROM temp.agent_sender_tracked AS tracked
    WHERE tracked.kind = changed.kind AND tracked.key = changed.key);`
}

// Why connection-local triggers: identity follows writes to the facts the history reads, from any
// writer on this connection, never heartbeats, receipts, read marks or mail; they roll back with
// their write, and nothing persists for older builds.
const GENERATION_SQL = `
CREATE TEMP TABLE IF NOT EXISTS agent_sender_generation (
  history INTEGER NOT NULL, principals INTEGER NOT NULL);
INSERT INTO temp.agent_sender_generation SELECT 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM temp.agent_sender_generation);
CREATE TEMP TABLE IF NOT EXISTS agent_sender_tracked (
  kind TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (kind, key)) WITHOUT ROWID;
CREATE TEMP TABLE IF NOT EXISTS agent_sender_dirty (
  kind TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (kind, key)) WITHOUT ROWID;
${projectionMutationTriggers(
  'agent_sender',
  HISTORY_TRIGGERS.map((trigger) => ({
    table: trigger.table,
    columns: trigger.columns,
    mark: (row) => markDirty(row, trigger)
  })),
  'UPDATE temp.agent_sender_generation SET history = history + 1;'
)}
${['insert', 'delete', 'update']
  .map(
    (name) => `CREATE TEMP TRIGGER IF NOT EXISTS agent_sender_federated_dispatches_${name}
AFTER ${name === 'update' ? 'UPDATE OF environment_id' : name.toUpperCase()} ON main.federated_dispatches
BEGIN UPDATE temp.agent_sender_generation SET principals = principals + 1; END;`
  )
  .join('\n')}`

export type AgentSenderGeneration = { history: string; principals: string }

/** Install the triggers once per connection, then read the generations they keep. data_version
 *  moves only for other connections' commits, which the triggers can't see. */
export function readAgentSenderGeneration(
  db: OrchestrationDb,
  install: boolean
): AgentSenderGeneration {
  if (install) {
    db.db.exec(GENERATION_SQL)
  }
  const row = z
    .object({ history: z.number(), principals: z.number() })
    .parse(db.db.prepare('SELECT history, principals FROM temp.agent_sender_generation').get())
  const external = String(db.db.pragma('data_version', { simple: true }))
  return { history: `${row.history}:${external}`, principals: `${row.principals}:${external}` }
}

/** The panes (`p:`) and Dispatch ids (`d:`) writes on this connection marked since the last clear. */
export function readAgentSenderDirtyKeys(db: OrchestrationDb): Set<string> {
  const rows = db.db.prepare('SELECT kind, key FROM temp.agent_sender_dirty').all()
  return new Set(
    tolerant(dirtyRow, rows).map(({ kind, key }) => `${kind === 'pane' ? 'p' : 'd'}:${key}`)
  )
}

/** Only once the history read them all: a failed refresh leaves every key for the next. */
export function clearAgentSenderDirtyKeys(db: OrchestrationDb): void {
  db.db.prepare('DELETE FROM temp.agent_sender_dirty').run()
}

/** Track only current direct dependencies; misses occupy one slot until their owner dies. */
export function trackAgentSenderHistoryKeys(
  db: OrchestrationDb,
  panes: Iterable<string>,
  dispatches: Iterable<string>,
  previous?: Set<string>
): void {
  const next = new Set([
    ...[...panes].map((key) => `p:${key}`),
    ...[...dispatches].map((id) => `d:${id}`)
  ])
  if (!previous) {
    db.db.prepare('DELETE FROM temp.agent_sender_tracked').run()
  }
  const insert = db.db.prepare('INSERT OR IGNORE INTO temp.agent_sender_tracked VALUES (?, ?)')
  const remove = db.db.prepare('DELETE FROM temp.agent_sender_tracked WHERE kind = ? AND key = ?')
  const parts = (key: string) => [key.startsWith('p:') ? 'pane' : 'dispatch', key.slice(2)]
  for (const key of next) {
    if (!previous?.has(key)) {
      insert.run(...parts(key))
    }
  }
  for (const key of previous ?? []) {
    if (!next.has(key)) {
      remove.run(...parts(key))
    }
  }
}

/** An unowned projection retains no event backlog; the next owner starts from current facts. */
export function releaseAgentSenderHistoryKeys(db: OrchestrationDb): void {
  db.db.prepare('DELETE FROM temp.agent_sender_tracked').run()
  clearAgentSenderDirtyKeys(db)
}
