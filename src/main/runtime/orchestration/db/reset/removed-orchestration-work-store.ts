import type Database from '../../../../sqlite/sync-database'
import {
  REMOVED_WORK_INT_FIELD,
  REMOVED_WORK_LINEAGE_FIELDS,
  type RemovedWorkKind
} from '../../../../../shared/orchestration-removed-work'

/**
 * One row per removed Task, Dispatch, worker or terminal, so deleting live rows never erases who
 * created what. Rowid key and no constraints: recording a removal must never fail the delete.
 * Rows live as long as their Run; reset --all clears the table.
 */
export const REMOVED_WORK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS removed_orchestration_work (
  seq        INTEGER PRIMARY KEY,
  run_id     TEXT,
  kind       TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  record     TEXT NOT NULL,
  removed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_removed_orchestration_work_run
  ON removed_orchestration_work(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_removed_orchestration_work_entity
  ON removed_orchestration_work(entity_id, kind);

-- Removals before recorded_since were not recorded; a Run created since then has a complete record.
CREATE TABLE IF NOT EXISTS removed_orchestration_work_coverage (
  singleton      INTEGER PRIMARY KEY CHECK(singleton = 1),
  recorded_since TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_runs_forget_removed_work
AFTER DELETE ON runs
BEGIN
  DELETE FROM removed_orchestration_work WHERE run_id = OLD.id;
END;
`

/** The Run of a Dispatch id, whichever of its rows a delete in any order has left behind. */
function runOfDispatchSql(dispatchIdSql: string): string {
  return `COALESCE(
    (SELECT run_id FROM dispatch_contexts WHERE id = ${dispatchIdSql}),
    (SELECT NULLIF(home_run_id, '') FROM remote_dispatch_attachments WHERE dispatch_id = ${dispatchIdSql}),
    (SELECT run_id FROM removed_orchestration_work
      WHERE entity_id = ${dispatchIdSql} AND kind IN ('dispatch', 'remote_worker')
      ORDER BY seq DESC LIMIT 1)
  )`
}

type CaptureSpec<K extends RemovedWorkKind> = {
  table: string
  entityIdSql: string
  runIdSql: string
  fields: Record<keyof (typeof REMOVED_WORK_LINEAGE_FIELDS)[K], string>
}

// Lineage columns only: spec, result, hashes, start options, effects and errors stay out.
const CAPTURE_SPECS: { [K in RemovedWorkKind]: CaptureSpec<K> } = {
  task: {
    table: 'tasks',
    entityIdSql: 'OLD.id',
    runIdSql: 'OLD.run_id',
    fields: {
      parentTaskId: 'OLD.parent_id',
      title: 'COALESCE(OLD.task_title, OLD.display_name)',
      createdByHandle: 'OLD.created_by_terminal_handle',
      createdByPaneKey: 'OLD.created_by_pane_key',
      deps: 'OLD.deps',
      status: 'OLD.status',
      createdAt: 'OLD.created_at'
    }
  },
  dispatch: {
    table: 'dispatch_contexts',
    entityIdSql: 'OLD.id',
    runIdSql: 'OLD.run_id',
    fields: {
      taskId: 'OLD.task_id',
      retryOfDispatchId: 'OLD.retry_of_dispatch_id',
      creatorDispatchId: 'OLD.creator_dispatch_id',
      creatorHandle: 'OLD.creator_handle',
      creatorPaneKey: 'OLD.creator_pane_key',
      creatorOrcaSessionId: 'OLD.creator_orca_session_id',
      assigneeHandle: 'OLD.assignee_handle',
      assigneePaneKey: 'OLD.assignee_pane_key',
      assigneeOrcaSessionId: 'OLD.assignee_orca_session_id',
      hostScope: 'OLD.host_scope',
      depth: 'OLD.depth',
      status: 'OLD.status',
      terminationReason: 'OLD.termination_reason',
      createdAt: 'OLD.created_at'
    }
  },
  worker: {
    table: 'worker_dispatches',
    entityIdSql: 'OLD.dispatch_id',
    runIdSql: runOfDispatchSql('OLD.dispatch_id'),
    fields: {
      state: 'OLD.state',
      stage: 'OLD.stage',
      worktreeId: 'OLD.worktree_id',
      terminalHandle: 'OLD.agent_terminal_handle',
      createdAt: 'OLD.created_at'
    }
  },
  terminal: {
    table: 'worker_terminal_resources',
    entityIdSql: 'OLD.id',
    runIdSql: `COALESCE(${runOfDispatchSql('OLD.owner_dispatch_id')}, ${runOfDispatchSql('OLD.origin_dispatch_id')})`,
    fields: {
      originDispatchId: 'OLD.origin_dispatch_id',
      ownerDispatchId: 'OLD.owner_dispatch_id',
      priorOwnerDispatchIds: 'OLD.prior_owner_dispatch_ids',
      terminalHandle: 'OLD.terminal_handle',
      paneKey: 'OLD.pane_key',
      worktreeId: 'OLD.worktree_id',
      hostScope: 'OLD.host_scope',
      ownershipState: 'OLD.ownership_state',
      releaseState: 'OLD.release_state',
      createdAt: 'OLD.created_at'
    }
  },
  remote_worker: {
    table: 'remote_dispatch_attachments',
    entityIdSql: 'OLD.dispatch_id',
    runIdSql: "NULLIF(OLD.home_run_id, '')",
    fields: {
      taskId: 'OLD.task_id',
      homePeerFingerprint: 'OLD.home_peer_fingerprint',
      state: 'OLD.state',
      stage: 'OLD.stage',
      worktreeId: 'OLD.worktree_id',
      terminalHandle: 'OLD.terminal_handle',
      paneKey: 'OLD.pane_key',
      depth: 'OLD.depth',
      createdAt: 'OLD.created_at'
    }
  },
  federated_worker: {
    table: 'federated_dispatches',
    entityIdSql: 'OLD.dispatch_id',
    runIdSql: runOfDispatchSql('OLD.dispatch_id'),
    fields: {
      environmentId: 'OLD.environment_id',
      environmentName: 'OLD.environment_name',
      remoteWorktreeId: 'OLD.remote_worktree_id',
      remoteTerminalHandle: 'OLD.remote_terminal_handle',
      dispatchStatus: '(SELECT status FROM dispatch_contexts WHERE id = OLD.dispatch_id)',
      createdAt: 'OLD.created_at'
    }
  }
}

const CAPTURE_KINDS: readonly RemovedWorkKind[] = [
  'task',
  'dispatch',
  'worker',
  'terminal',
  'remote_worker',
  'federated_worker'
]

const triggerName = (kind: RemovedWorkKind): string =>
  `trg_${CAPTURE_SPECS[kind].table}_record_removed_work`

export const DROP_REMOVED_WORK_TRIGGERS_SQL = CAPTURE_KINDS.map(
  (kind) => `DROP TRIGGER IF EXISTS ${triggerName(kind)};`
).join('\n')

// CAST keeps a stray BLOB from throwing in json_object; JSON columns are copied as raw text.
function captureTriggerSql(kind: RemovedWorkKind): string {
  const spec = CAPTURE_SPECS[kind]
  const lineageFields: Record<string, unknown> = REMOVED_WORK_LINEAGE_FIELDS[kind]
  const fields = Object.entries<string>(spec.fields).map(
    ([key, sql]) =>
      `'${key}', CAST(${sql} AS ${lineageFields[key] === REMOVED_WORK_INT_FIELD ? 'INTEGER' : 'TEXT'})`
  )
  return `CREATE TRIGGER ${triggerName(kind)}
AFTER DELETE ON ${spec.table}
BEGIN
  INSERT INTO removed_orchestration_work (run_id, kind, entity_id, record)
  VALUES (CAST(${spec.runIdSql} AS TEXT), '${kind}', COALESCE(CAST(${spec.entityIdSql} AS TEXT), ''),
    json_object('v', 1, ${fields.join(', ')}));
END;`
}

export function isRemovedWorkCaptureIntact(db: Database.Database): boolean {
  const names = CAPTURE_KINDS.map((kind) => `'${triggerName(kind)}'`).join(', ')
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${names})`
    )
    .get()
  return Number(row?.n) === CAPTURE_KINDS.length
}

// A moved marker sorts after every existing non-legacy Run, so none of them reads complete.
const MOVED_RECORDED_SINCE_SQL = `MAX(datetime('now'), COALESCE(
  (SELECT datetime(MAX(created_at), '+1 second') FROM runs WHERE legacy = 0), ''))`

/**
 * Recreated on every open, after every open step that creates Runs and before any that deletes work:
 * the bodies name columns, so a body stamped once would keep an older build's columns. Coverage moves
 * whenever any trigger was missing before this open, so a record never claims removals it did not see.
 */
export function installRemovedWorkCapture(db: Database.Database, captureWasIntact: boolean): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      ${DROP_REMOVED_WORK_TRIGGERS_SQL}
      ${CAPTURE_KINDS.map(captureTriggerSql).join('\n')}
      INSERT OR ${captureWasIntact ? 'IGNORE' : 'REPLACE'} INTO removed_orchestration_work_coverage
        (singleton, recorded_since)
        VALUES (1, ${captureWasIntact ? "datetime('now')" : MOVED_RECORDED_SINCE_SQL});
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
