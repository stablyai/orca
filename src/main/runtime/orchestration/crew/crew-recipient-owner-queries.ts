import { z } from 'zod'
import { isOrcaSessionId, type OrcaSessionId } from '../../../../shared/orca-session-address'
import type { OrchestrationDb } from '../db'
import {
  RUN_PANE_KEY_MATCH_SUFFIX_SQL,
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL
} from '../db/pane-key-match'
import { workerSeatGrabSql } from '../db/runs/run-coordinator-mail-routing'

const nullable = z.string().nullable()
const sessionId = z.custom<OrcaSessionId>(
  (value) => typeof value === 'string' && isOrcaSessionId(value)
)
const Run = z.object({
  id: z.string(),
  legacy: z.number(),
  home_database: z.string(),
  coordinator_pane_key: nullable,
  coordinator_orca_session_id: sessionId.nullable(),
  coordinator_orca_session_id_generation: z.number().nullable(),
  consumer_generation: z.number()
})
const Resource = z.object({
  terminal_handle: z.string(),
  pane_key: nullable,
  process_incarnation: nullable,
  worktree_id: nullable,
  host_scope: nullable,
  owner_dispatch_id: z.string(),
  ownership_state: z.enum(['owned', 'transferred', 'user_owned', 'external', 'released']),
  release_state: z.enum([
    'not_requested',
    'retained',
    'requested',
    'releasing',
    'released',
    'unknown'
  ])
})
const resource = (alias: string) => `CASE WHEN ${alias}.id IS NOT NULL THEN json_object(
  'terminal_handle', ${alias}.terminal_handle, 'pane_key', ${alias}.pane_key,
  'process_incarnation', ${alias}.process_incarnation, 'worktree_id', ${alias}.worktree_id,
  'host_scope', ${alias}.host_scope, 'owner_dispatch_id', ${alias}.owner_dispatch_id,
  'ownership_state', ${alias}.ownership_state, 'release_state', ${alias}.release_state) END`
const resourceValue = nullable.transform((value) =>
  value === null ? null : Resource.parse(JSON.parse(value))
)
const Dispatch = z.object({
  key: z.string(),
  branch: z.enum(['handle', 'pane', 'suffix', 'explicit']),
  id: z.string(),
  run_id: z.string(),
  contract_version: z.number(),
  status: z.string(),
  follow_up_of_dispatch_id: nullable,
  next_dispatch_id: nullable,
  creator_handle: nullable,
  creator_pane_key: nullable,
  assignee_handle: nullable,
  assignee_pane_key: nullable,
  assignee_orca_session_id: sessionId.nullable(),
  process_incarnation: nullable,
  protocol_version: z.number().nullable(),
  worker_state: nullable,
  sender_run_id: nullable,
  sender_run_legacy: z.number().nullable(),
  nested_resource: resourceValue
})
export type DispatchInput = z.infer<typeof Dispatch>

const workerState = z.enum([
  'starting',
  'ready',
  'start_unknown',
  'failed',
  'succeeded',
  'stopping',
  'stop_unknown',
  'stopped',
  'abandoned',
  'unsupervised'
])
const Identity = z.object({
  root: sessionId,
  recorded: z.number(),
  identity_resource: resourceValue,
  custody_resource: resourceValue,
  owner_state: workerState
})

export type CrewRecipientRun = z.infer<typeof Run>
const runColumns = `r.id, r.legacy, r.home_database, r.coordinator_pane_key, r.coordinator_orca_session_id,
  r.coordinator_orca_session_id_generation, r.consumer_generation`

const dispatchColumns = `d.id, d.run_id, d.contract_version, d.status, d.follow_up_of_dispatch_id,
      (SELECT next.id FROM dispatch_contexts next WHERE next.follow_up_of_dispatch_id = d.id) AS next_dispatch_id, d.creator_handle, d.creator_pane_key, d.assignee_handle, d.assignee_pane_key,
      d.assignee_orca_session_id, d.process_incarnation, f.protocol_version, w.state AS worker_state, s.id AS sender_run_id, s.legacy AS sender_run_legacy, ${resource('h')} AS nested_resource`

/** Selected owner queries return complete source rows, never recipient decisions. */
export function crewRecipientOwnerQueries(db: OrchestrationDb) {
  const identity = (request: { root: string; incarnation: string; handle: string | null }[]) => {
    return Identity.array().parse(
      db.db
        .prepare(`WITH requested AS (
      SELECT json_extract(value, '$.root') AS root, json_extract(value, '$.incarnation') AS incarnation,
        json_extract(value, '$.handle') AS handle FROM json_each(?)
    ) SELECT requested.root,
      EXISTS(SELECT 1 FROM dispatch_contexts WHERE assignee_orca_session_id = requested.root
        AND process_incarnation = requested.incarnation) AS recorded,
      ${resource('p')} AS identity_resource, ${resource('h')} AS custody_resource,
      COALESCE(w.state, a.state, 'unsupervised') AS owner_state
    FROM requested
    LEFT JOIN worker_terminal_resources p ON p.id = (
      SELECT id FROM worker_terminal_resources WHERE process_incarnation = requested.incarnation ORDER BY updated_at DESC LIMIT 1)
    LEFT JOIN worker_terminal_resources h ON h.id = (
      SELECT id FROM worker_terminal_resources WHERE terminal_handle = COALESCE(requested.handle, p.terminal_handle) ORDER BY updated_at DESC LIMIT 1)
    LEFT JOIN worker_dispatches w ON w.dispatch_id = h.owner_dispatch_id
    LEFT JOIN remote_dispatch_attachments a ON a.dispatch_id = h.owner_dispatch_id`)
        .all(JSON.stringify(request))
    )
  }
  const currentRuns = (
    requested: { key: string; session: string | null; suffix: string | null; id?: string }[]
  ) => {
    return Run.extend({ key: z.string() })
      .array()
      .parse(
        db.db
          .prepare(`WITH requested AS (
      SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.session') AS session,
        json_extract(value, '$.suffix') AS suffix, json_extract(value, '$.id') AS id FROM json_each(?)
    ), candidates AS (
      SELECT requested.key, r.rowid AS ordinal, ${runColumns} FROM requested CROSS JOIN runs r
      WHERE r.legacy = 0 AND r.coordinator_orca_session_id = requested.session
      UNION
      SELECT requested.key, r.rowid AS ordinal, ${runColumns} FROM requested CROSS JOIN runs r
      WHERE r.legacy = 0 AND r.coordinator_pane_key IS NOT NULL AND ${RUN_PANE_KEY_MATCH_SUFFIX_SQL.replaceAll('coordinator_pane_key', 'r.coordinator_pane_key')} = requested.suffix
      UNION
      SELECT requested.key, r.rowid AS ordinal, ${runColumns} FROM requested JOIN runs r ON r.id = requested.id
    ) SELECT * FROM candidates ORDER BY ordinal DESC`)
          .all(JSON.stringify(requested))
      )
  }
  const dispatches = (
    request: {
      key: string
      handle: string
      caller: boolean
      pane: string | null
      suffix: string | null
      id?: string
    }[]
  ) => {
    return Dispatch.array().parse(
      db.db
        .prepare(`WITH requested AS (
      SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.handle') AS handle, json_extract(value, '$.pane') AS pane,
        json_extract(value, '$.suffix') AS suffix, json_extract(value, '$.caller') AS caller, json_extract(value, '$.id') AS id FROM json_each(?)
    ), candidates AS (
      SELECT requested.key, requested.caller, 'handle' AS branch, d.rowid AS ordinal, d.* FROM requested CROSS JOIN dispatch_contexts d
        WHERE requested.id IS NULL AND d.status IN ('pending', 'dispatched') AND d.assignee_handle = requested.handle
      UNION ALL
      SELECT requested.key, requested.caller, 'pane', d.rowid, d.* FROM requested CROSS JOIN dispatch_contexts d
        WHERE requested.id IS NULL AND d.status IN ('pending', 'dispatched') AND d.assignee_pane_key = requested.pane
      UNION ALL
      SELECT requested.key, requested.caller, 'suffix', d.rowid, d.* FROM requested CROSS JOIN dispatch_contexts d
        WHERE requested.id IS NULL AND d.status IN ('pending', 'dispatched') AND d.assignee_pane_key IS NOT NULL
          AND instr(d.assignee_pane_key, ':') > 1 AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL.replaceAll('assignee_pane_key', 'd.assignee_pane_key')} = requested.suffix
      UNION ALL
      SELECT requested.key, requested.caller, 'explicit', d.rowid, d.* FROM requested JOIN dispatch_contexts d ON d.id = requested.id
    ) SELECT d.key, d.branch, ${dispatchColumns} FROM candidates d
      LEFT JOIN runs s ON s.id = d.run_id
      LEFT JOIN federated_dispatches f ON f.dispatch_id = d.id
      LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
      LEFT JOIN worker_terminal_resources h ON h.id = (
        SELECT id FROM worker_terminal_resources WHERE terminal_handle = d.assignee_handle ORDER BY updated_at DESC LIMIT 1)
      ORDER BY d.ordinal DESC`)
        .all(JSON.stringify(request))
    )
  }
  const history = (request: { key: string; handle: string }[]) => {
    return z
      .object({ key: z.string(), run_id: z.string() })
      .array()
      .parse(
        db.db
          .prepare(`
      SELECT json_extract(requested.value, '$.key') AS key, coordinator.run_id FROM json_each(?) requested
      CROSS JOIN run_coordinator_handles coordinator JOIN runs ON runs.id = coordinator.run_id AND runs.legacy = 0
      WHERE coordinator.terminal_handle = json_extract(requested.value, '$.handle') AND NOT ${workerSeatGrabSql('coordinator')}
      ORDER BY coordinator.run_id`)
          .all(JSON.stringify(request))
      )
  }
  const resourceFor = (id: string) => `COALESCE(
    (SELECT id FROM worker_terminal_resources WHERE owner_dispatch_id = ${id}),
    (SELECT id FROM worker_terminal_resources WHERE prior_owner_dispatch_ids LIKE '%"' || ${id} || '"%' ORDER BY updated_at DESC LIMIT 1))`
  const followUps = (ids: string[]) => {
    return Dispatch.extend({
      lineage_resource: nullable.transform((value) =>
        value === null
          ? null
          : z
              .object({
                owner_dispatch_id: z.string(),
                origin_dispatch_id: z.string()
              })
              .parse(JSON.parse(value))
      ),
      has_worker: z.number()
    })
      .array()
      .parse(
        db.db
          .prepare(`WITH RECURSIVE crew_follow_up_seeds(id) AS (
      SELECT value FROM json_each(?)
    ), crew_follow_up_nodes(id) AS (
      SELECT id FROM crew_follow_up_seeds
      UNION SELECT d.follow_up_of_dispatch_id FROM crew_follow_up_nodes n JOIN dispatch_contexts d ON d.id = n.id WHERE d.follow_up_of_dispatch_id IS NOT NULL
      UNION SELECT d.id FROM crew_follow_up_nodes n JOIN dispatch_contexts d ON d.follow_up_of_dispatch_id = n.id
      UNION SELECT r.owner_dispatch_id FROM crew_follow_up_nodes n JOIN worker_terminal_resources r ON r.id = ${resourceFor('n.id')}
      UNION SELECT r.origin_dispatch_id FROM crew_follow_up_nodes n JOIN worker_terminal_resources r ON r.id = ${resourceFor('n.id')}
    ) SELECT d.id AS key, 'explicit' AS branch, ${dispatchColumns},
      CASE WHEN lineage.id IS NOT NULL THEN json_object('owner_dispatch_id', lineage.owner_dispatch_id,
        'origin_dispatch_id', lineage.origin_dispatch_id) END AS lineage_resource,
      EXISTS(SELECT 1 FROM worker_dispatches WHERE dispatch_id = d.id) AS has_worker
    FROM crew_follow_up_nodes n JOIN dispatch_contexts d ON d.id = n.id
    LEFT JOIN runs s ON s.id = d.run_id
    LEFT JOIN federated_dispatches f ON f.dispatch_id = d.id
    LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
    LEFT JOIN worker_terminal_resources h ON h.id = (
      SELECT id FROM worker_terminal_resources WHERE terminal_handle = d.assignee_handle ORDER BY updated_at DESC LIMIT 1)
    LEFT JOIN worker_terminal_resources lineage ON lineage.id = ${resourceFor('d.id')}`)
          .all(JSON.stringify(ids))
      )
  }
  return { identity, currentRuns, dispatches, history, followUps }
}
