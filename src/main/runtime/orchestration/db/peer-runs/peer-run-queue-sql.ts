import type Database from '../../../../sqlite/sync-database'
import { REMOTE_OWNED_WIRE_VERSION } from '../../../../../shared/orchestration/remote-owned-wire'
import { crossMachineMessageTypeSql } from '../../federation/cross-machine-message-type'

/**
 * A Run here whose coordinator is a paired Orca, keyed by the conversation its queue goes home
 * under. It outlives this Orca's resets, so the conversation keeps its Run ID and its sequence.
 * Each conversation's next `to_home` sequence is persistent too, so a reset never reuses one.
 * A worker message's Dispatch is recorded when it is filed, before any reroute into the Run.
 */
export const PEER_RUN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS peer_runs (
  run_id           TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL UNIQUE,
  peer_fingerprint TEXT NOT NULL,
  home_run_id      TEXT NOT NULL,
  home_label       TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'closed')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS federation_relay_sequences (
  dispatch_id   TEXT NOT NULL,
  direction     TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  PRIMARY KEY (dispatch_id, direction)
);

-- A Dispatch whose report owner's correction is being written: its edges queue nothing until the
-- row is removed, which queues the corrected state once, flagged.
CREATE TABLE IF NOT EXISTS peer_run_corrections (
  dispatch_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS message_dispatch_provenance (
  message_id  TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  task_id     TEXT NOT NULL
);
`

/** A peer-Run Dispatch as a `worker_state` item carries it, with its Task and Run. */
const PEER_RUN_DISPATCH_STATE_VIEW_SQL = `
DROP VIEW IF EXISTS peer_run_dispatch_state;
CREATE VIEW peer_run_dispatch_state AS
SELECT d.id AS dispatch_id, pr.conversation_id, pr.home_run_id, pr.run_id AS peer_run_id,
  json_object(
    'id', d.id, 'taskId', d.task_id, 'status', d.status, 'workerState', w.state,
    'lastFailure', d.last_failure, 'agent', json_extract(w.start_options, '$.agent')
  ) AS dispatch_json,
  json_object('status', t.status, 'result', t.result) AS task_json
FROM dispatch_contexts d
JOIN peer_runs pr ON pr.run_id = d.run_id
JOIN tasks t ON t.id = d.task_id
LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id;
`

const SEQUENCE = `(SELECT last_sequence FROM federation_relay_sequences
  WHERE dispatch_id = conversation_id AND direction = 'to_home')`

/**
 * Takes the conversation's next sequence, then queues the item under it. `rows` selects at most one
 * row with `conversation_id` and the item's `message_id` and `payload`; both statements read it.
 */
function queueItemStatements(rows: string, kind: string): [string, string] {
  return [
    `INSERT INTO federation_relay_sequences (dispatch_id, direction, last_sequence)
     SELECT conversation_id, 'to_home', 1 FROM (${rows}) WHERE true
     ON CONFLICT(dispatch_id, direction) DO UPDATE SET last_sequence = last_sequence + 1`,
    `INSERT INTO federation_relay_items
       (dispatch_id, direction, sequence, message_id, kind, payload, byte_count)
     SELECT conversation_id, 'to_home', ${SEQUENCE}, message_id, '${kind}', payload, length(payload)
     FROM (${rows})`
  ]
}

/** One `worker_state` item for a peer-Run Dispatch; its ID is the sequence it is queued under. */
export function peerRunDispatchStateStatements(
  dispatchId: string,
  corrected: boolean,
  removed: string
): [string, string] {
  return queueItemStatements(
    `SELECT conversation_id, 'state_' || ${SEQUENCE} AS message_id,
       json_object(
         'v', ${REMOTE_OWNED_WIRE_VERSION}, 'id', 'state_' || ${SEQUENCE},
         'homeRunId', home_run_id, 'peerRunId', peer_run_id,
         'dispatch', json(dispatch_json), 'task', json(task_json),
         'correctedUnobservedPrompt', json('${corrected}'),
         'removed', ${removed}
       ) AS payload
     FROM peer_run_dispatch_state WHERE dispatch_id = ${dispatchId}`,
    'worker_state'
  )
}

/** A message filed in a peer Run's mailbox, once, with the Dispatch its sender worked for. */
function peerRunMailStatements(row: string): [string, string] {
  return queueItemStatements(
    `SELECT pr.conversation_id, ${row}.id AS message_id,
       json_object(
         'v', ${REMOTE_OWNED_WIRE_VERSION}, 'id', ${row}.id,
         'homeRunId', pr.home_run_id, 'peerRunId', pr.run_id,
         'message', json_object(
           'from', ${row}.from_handle, 'type', ${crossMachineMessageTypeSql(`${row}.type`)},
           'subject', ${row}.subject,
           'body', ${row}.body, 'payload', ${row}.payload, 'priority', ${row}.priority,
           'threadId', ${row}.thread_id
         ),
         'dispatchId', p.dispatch_id, 'taskId', p.task_id
       ) AS payload
     FROM peer_runs pr
     LEFT JOIN message_dispatch_provenance p ON p.message_id = ${row}.id
     WHERE ${row}.to_handle = 'run:' || pr.run_id
       AND NOT EXISTS (
         SELECT 1 FROM federation_relay_items
         WHERE dispatch_id = pr.conversation_id AND direction = 'to_home'
           AND message_id = ${row}.id
       )`,
    'worker_mail'
  )
}

const LATEST_TASK_DISPATCH = (taskId: string) =>
  `(SELECT id FROM dispatch_contexts WHERE task_id = ${taskId} ORDER BY rowid DESC LIMIT 1)`

const NOT_CORRECTING = (dispatchId: string) =>
  `NOT EXISTS (SELECT 1 FROM peer_run_corrections WHERE dispatch_id = ${dispatchId})`

const trigger = (statements: [string, string]) => `BEGIN ${statements.join(';\n')}; END;`

/**
 * Every final message of a peer Run's mailbox and every lifecycle change of its Dispatches, their
 * workers and their Tasks queue home in the transaction that made them. Rebuilt on every open.
 * The report owner's unobserved-prompt correction queues once, flagged, after all its writes.
 */
export function createPeerRunQueueTriggers(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      ${PEER_RUN_DISPATCH_STATE_VIEW_SQL}
      DROP TRIGGER IF EXISTS trg_peer_run_mail_insert;
      DROP TRIGGER IF EXISTS trg_peer_run_mail_reroute;
      DROP TRIGGER IF EXISTS trg_peer_run_dispatch_insert;
      DROP TRIGGER IF EXISTS trg_peer_run_dispatch_status;
      DROP TRIGGER IF EXISTS trg_peer_run_worker_state;
      DROP TRIGGER IF EXISTS trg_peer_run_task_status;
      DROP TRIGGER IF EXISTS trg_peer_run_correction;
      CREATE TRIGGER trg_peer_run_mail_insert AFTER INSERT ON messages
      WHEN NEW.to_handle LIKE 'run:%' AND NEW.type <> 'heartbeat'
      ${trigger(peerRunMailStatements('NEW'))}
      CREATE TRIGGER trg_peer_run_mail_reroute AFTER UPDATE OF to_handle ON messages
      WHEN NEW.to_handle LIKE 'run:%' AND NEW.to_handle <> OLD.to_handle AND NEW.type <> 'heartbeat'
      ${trigger(peerRunMailStatements('NEW'))}
      CREATE TRIGGER trg_peer_run_dispatch_insert AFTER INSERT ON dispatch_contexts
      ${trigger(peerRunDispatchStateStatements('NEW.id', false, 'NULL'))}
      CREATE TRIGGER trg_peer_run_dispatch_status AFTER UPDATE OF status ON dispatch_contexts
      WHEN NEW.status <> OLD.status AND ${NOT_CORRECTING('NEW.id')}
      ${trigger(peerRunDispatchStateStatements('NEW.id', false, 'NULL'))}
      CREATE TRIGGER trg_peer_run_worker_state AFTER UPDATE OF state ON worker_dispatches
      WHEN NEW.state <> OLD.state AND ${NOT_CORRECTING('NEW.dispatch_id')}
      ${trigger(peerRunDispatchStateStatements('NEW.dispatch_id', false, 'NULL'))}
      CREATE TRIGGER trg_peer_run_task_status AFTER UPDATE OF status ON tasks
      WHEN NEW.status <> OLD.status AND NOT EXISTS (
        SELECT 1 FROM peer_run_corrections c JOIN dispatch_contexts d ON d.id = c.dispatch_id
        WHERE d.task_id = NEW.id
      )
      ${trigger(peerRunDispatchStateStatements(LATEST_TASK_DISPATCH('NEW.id'), false, 'NULL'))}
      CREATE TRIGGER trg_peer_run_correction AFTER DELETE ON peer_run_corrections
      ${trigger(peerRunDispatchStateStatements('OLD.dispatch_id', true, 'NULL'))}
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
