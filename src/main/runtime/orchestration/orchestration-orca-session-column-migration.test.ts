import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { RUN_PANE_KEY_MATCH_SUFFIX_SQL } from './db/pane-key-match'
import { DROP_REMOVED_WORK_TRIGGERS_SQL } from './db/reset/removed-orchestration-work-store'
import {
  currentRunCoordinatorOrcaSessionId,
  currentRunCoordinatorOrcaSessionIdSql
} from './db/runs/run-coordinator-orca-session'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

const SESSION_ID = testOrcaSessionId('5f0c1d9e-2b7a-4c3e-8f61-0a9d2e7b4c11')
const CHAT_SESSION_ID = testOrcaSessionId('9a4e7c1b-3d2f-4b6a-8e5c-7f1d0b2a6c93')
const CHAT_SESSION_ADDRESS = formatOrcaSessionAddress(CHAT_SESSION_ID)
const ORCA_SESSION_ID_COLUMNS = [
  'assignee_orca_session_id',
  'coordinator_orca_session_id',
  'coordinator_orca_session_id_generation',
  'creator_orca_session_id'
]
const COORDINATOR_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'
const PTY_WORKER_PANE = 'tab_pty:22222222-2222-4222-8222-222222222222'
const NESTED_PANE = 'tab_nested:33333333-3333-4333-8333-333333333333'
const UNCAPPED = Number.MAX_SAFE_INTEGER

// Pre-v42 coordinator triggers remember handles only.
const HANDLE_ONLY_COORDINATOR_TRIGGERS_SQL = `
  CREATE TRIGGER trg_runs_remember_coordinator_insert
  AFTER INSERT ON runs
  WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
  BEGIN
    INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
    VALUES (NEW.id, NEW.coordinator_handle);
  END;
  CREATE TRIGGER trg_runs_remember_coordinator_update
  AFTER UPDATE OF coordinator_handle ON runs
  WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
  BEGIN
    INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
    VALUES (NEW.id, NEW.coordinator_handle);
  END;`

// Pre-v42 mail routing is handle-only.
const HANDLE_ONLY_MAIL_ROUTING_TRIGGER_SQL = `
  CREATE TRIGGER trg_messages_route_coordinator_mail
  AFTER INSERT ON messages
  WHEN NEW.read = 0 AND NEW.delivery_contract = 'current_delivery'
    AND EXISTS (SELECT 1 FROM runs WHERE runs.id = NEW.run_id AND runs.legacy = 0)
    AND EXISTS (
      SELECT 1 FROM run_coordinator_handles
      WHERE run_id = NEW.run_id AND terminal_handle = NEW.to_handle
    )
    AND NOT EXISTS (
      SELECT 1 FROM dispatch_contexts
      WHERE run_id = NEW.run_id AND assignee_handle = NEW.to_handle
        AND status IN ('pending', 'dispatched')
    )
  BEGIN
    UPDATE messages SET to_handle = 'run:' || NEW.run_id WHERE sequence = NEW.sequence;
  END;`

const V41_RUN_COLUMNS =
  'id, objective, home_database, coordinator_handle, coordinator_pane_key, consumer_generation, legacy, created_at, updated_at'

type SeededRows = {
  ptyRunId: string
  structuredRunId: string
  structuredDispatchId: string
  ptyDispatchId: string
  nestedDispatchId: string
  workerHandle: string
}

/** One PTY coordinator with a structured worker and a PTY worker; the structured worker runs a nested Run. */
function seedStructuredAndPtyRows(db: OrchestrationDb): SeededRows {
  const workerHandle = mintStructuredWorkerHandle()
  const workerPane = mintStructuredWorkerPaneKey(SESSION_ID)
  const coordinator = { kind: 'terminal', handle: 'term_coord', paneKey: COORDINATOR_PANE } as const
  const ptyRun = db.createRun({
    objective: 'pty coordinator',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE
  })
  const structuredDispatch = db.createDispatchContext({
    taskId: db.createTask({ runId: ptyRun.id, spec: 'structured worker' }).id,
    assigneeHandle: workerHandle,
    assigneePaneKey: workerPane,
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    creator: coordinator,
    maxDepth: UNCAPPED
  })
  const ptyDispatch = db.createDispatchContext({
    taskId: db.createTask({ runId: ptyRun.id, spec: 'pty worker' }).id,
    assigneeHandle: 'term_pty_worker',
    assigneePaneKey: PTY_WORKER_PANE,
    processIncarnation: 'pty_proc_7f3a:4242',
    creator: coordinator,
    maxDepth: UNCAPPED
  })
  const structuredRun = db.createRun({
    objective: 'structured worker coordinates a nested run',
    coordinatorHandle: workerHandle,
    coordinatorPaneKey: workerPane
  })
  const nestedDispatch = db.createDispatchContext({
    taskId: db.createTask({ runId: structuredRun.id, spec: 'nested' }).id,
    assigneeHandle: 'term_nested',
    assigneePaneKey: NESTED_PANE,
    creator: { kind: 'terminal', handle: workerHandle, paneKey: workerPane },
    maxDepth: UNCAPPED
  })
  return {
    ptyRunId: ptyRun.id,
    structuredRunId: structuredRun.id,
    structuredDispatchId: structuredDispatch.id,
    ptyDispatchId: ptyDispatch.id,
    nestedDispatchId: nestedDispatch.id,
    workerHandle
  }
}

/** Strips a current database back to the shape main stamps at v41 and stamps `version`. */
function stripOrcaSessionSchema(path: string, version: number): void {
  const raw = new Database(path)
  raw.exec(`
    ${DROP_REMOVED_WORK_TRIGGERS_SQL}
    DROP INDEX idx_runs_coordinator_orca_session_id;
    DROP INDEX IF EXISTS idx_dispatch_session_presentation;
    DROP INDEX idx_dispatch_assignee_orca_session_id;
    DROP TRIGGER trg_runs_remember_coordinator_insert;
    DROP TRIGGER trg_runs_remember_coordinator_update;
    DROP TRIGGER trg_messages_route_coordinator_mail;
    ALTER TABLE runs DROP COLUMN coordinator_orca_session_id;
    ALTER TABLE runs DROP COLUMN coordinator_orca_session_id_generation;
    ALTER TABLE dispatch_contexts DROP COLUMN assignee_orca_session_id;
    ALTER TABLE dispatch_contexts DROP COLUMN creator_orca_session_id;
    ${HANDLE_ONLY_COORDINATOR_TRIGGERS_SQL}
    ${HANDLE_ONLY_MAIL_ROUTING_TRIGGER_SQL}
  `)
  raw.pragma(`user_version = ${version}`)
  raw.close()
}

/** The plan for finding a caller's Runs by pane leaf or by coordinator Orca session id in one statement. */
function coordinatorLookupPlan(db: Database.Database): string {
  return db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM runs
       WHERE legacy = 0 AND (
         (coordinator_pane_key IS NOT NULL AND ${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?)
         OR coordinator_orca_session_id = ?
       )`
    )
    .all('leaf', CHAT_SESSION_ID)
    .map((row) => String(row.detail))
    .join(' | ')
}

function coordinatorTriggerSql(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger'
       AND name IN ('trg_runs_remember_coordinator_insert', 'trg_runs_remember_coordinator_update')
       ORDER BY name`
    )
    .all()
    .map((row) => String(row.sql))
}

function orcaSessionColumns(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT name FROM pragma_table_info('runs')
       UNION ALL SELECT name FROM pragma_table_info('dispatch_contexts')`
    )
    .all()
    .map((column) => String(column.name))
    .filter((name) => name.includes('_orca_session_id'))
    .sort()
}

function coordinatorAddresses(db: Database.Database, runIds: string[]): string[] {
  return db
    .prepare(
      `SELECT run_id, terminal_handle FROM run_coordinator_handles
       WHERE run_id IN (${runIds.map(() => '?').join(', ')})`
    )
    .all(...runIds)
    .map((row) => `${String(row.run_id)} ${String(row.terminal_handle)}`)
    .sort()
}

describe('orchestration Orca session id column migration', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function tempDbPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-session-column-migration-'))
    tempRoots.push(root)
    return join(root, 'orchestration.db')
  }

  it('starts a v41 database at v41 and gives exactly its structured-worker rows an Orca session id', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripOrcaSessionSchema(path, 41)

    const probe = new Database(path)
    try {
      // Registering v42 probes at v41 would wrongly replay from v6.
      expect(resolveOrchestrationMigrationStartVersion(probe, 41, SCHEMA_VERSION)).toBe(41)
    } finally {
      probe.close()
    }

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(db.getDispatchContextById(rows.structuredDispatchId)).toMatchObject({
        assignee_orca_session_id: SESSION_ID,
        creator_orca_session_id: null
      })
      expect(db.getDispatchContextById(rows.ptyDispatchId)).toMatchObject({
        assignee_orca_session_id: null,
        creator_orca_session_id: null
      })
      expect(db.getDispatchContextById(rows.nestedDispatchId)).toMatchObject({
        assignee_orca_session_id: null,
        creator_orca_session_id: SESSION_ID
      })
      expect(
        db.db
          .prepare('SELECT id FROM dispatch_contexts WHERE assignee_orca_session_id IS NOT NULL')
          .all()
      ).toEqual([{ id: rows.structuredDispatchId }])
      expect(db.getRunRaw(rows.ptyRunId)?.coordinator_orca_session_id).toBeNull()
      expect(db.getRunRaw(rows.structuredRunId)?.coordinator_orca_session_id).toBe(SESSION_ID)
      expect(coordinatorAddresses(db.db, [rows.ptyRunId, rows.structuredRunId])).toEqual(
        [
          `${rows.ptyRunId} term_coord`,
          `${rows.structuredRunId} ${rows.workerHandle}`,
          `${rows.structuredRunId} ${formatOrcaSessionAddress(SESSION_ID)}`
        ].sort()
      )
      // IF NOT EXISTS alone would preserve obsolete handle-only triggers.
      for (const sql of coordinatorTriggerSql(db.db)) {
        expect(sql).toContain(
          'NEW.coordinator_orca_session_id_generation = NEW.consumer_generation'
        )
      }
    } finally {
      db.close()
    }
  })

  it('starts a v40 database at v40 and runs v41 before v42', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripOrcaSessionSchema(path, 40)
    const raw = new Database(path)
    raw.exec(`
      DROP TRIGGER trg_deliveries_one_outstanding;
      DROP VIEW outstanding_deliveries;
      DROP INDEX idx_deliveries_one_outstanding;
      CREATE UNIQUE INDEX idx_deliveries_one_outstanding
        ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
    `)
    try {
      expect(resolveOrchestrationMigrationStartVersion(raw, 40, SCHEMA_VERSION)).toBe(40)
    } finally {
      raw.close()
    }

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(orcaSessionColumns(db.db)).toEqual(ORCA_SESSION_ID_COLUMNS)
      const index = db.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_deliveries_one_outstanding'")
        .get()
      expect(String(index?.sql)).not.toContain('UNIQUE')
      expect(db.getDispatchContextById(rows.structuredDispatchId)?.assignee_orca_session_id).toBe(
        SESSION_ID
      )
      expect(db.getDispatchContextById(rows.ptyDispatchId)?.assignee_orca_session_id).toBeNull()
    } finally {
      db.close()
    }
  })

  it('upgrades a database from before the coordinator cache through the static triggers', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripOrcaSessionSchema(path, 27)
    const raw = new Database(path)
    raw.exec(`
      DROP TRIGGER trg_runs_remember_coordinator_insert;
      DROP TRIGGER trg_runs_remember_coordinator_update;
      DROP TABLE run_coordinator_handles;
    `)
    raw.close()

    // Static triggers must compile before migration adds session columns.
    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      for (const sql of coordinatorTriggerSql(db.db)) {
        expect(sql).toContain(
          'NEW.coordinator_orca_session_id_generation = NEW.consumer_generation'
        )
      }
      expect(db.getRunRaw(rows.structuredRunId)?.coordinator_orca_session_id).toBe(SESSION_ID)
      expect(coordinatorAddresses(db.db, [rows.ptyRunId])).toEqual([`${rows.ptyRunId} term_coord`])
    } finally {
      db.close()
    }
  })

  it('lets a v41 binary read and write a v42 database with Orca session ids in it', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    const upgraded = new OrchestrationDb(path)
    expect(upgraded.getRunRaw(rows.structuredRunId)?.coordinator_orca_session_id).toBe(SESSION_ID)
    upgraded.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_orca_session_id, coordinator_orca_session_id_generation, consumer_generation, legacy
         ) VALUES ('run_session', 'session coordinator', ?, 1, 1, 0)`
      )
      .run(CHAT_SESSION_ID)
    upgraded.close()

    // Use a raw connection to execute the rolled-back v41 SQL.
    const v41 = new Database(path)
    try {
      expect(resolveOrchestrationMigrationStartVersion(v41, SCHEMA_VERSION, 41)).toBe(
        SCHEMA_VERSION
      )
      expect(
        v41.prepare(`SELECT ${V41_RUN_COLUMNS} FROM runs WHERE id = ?`).get('run_session')
      ).toMatchObject({ id: 'run_session', coordinator_handle: null, coordinator_pane_key: null })
      expect(
        v41.prepare(`SELECT ${V41_RUN_COLUMNS} FROM runs WHERE id = ?`).get(rows.ptyRunId)
      ).toMatchObject({ coordinator_handle: 'term_coord', coordinator_pane_key: COORDINATOR_PANE })
      const listed = v41.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC').all()
      expect(listed.map((run) => run.id).sort()).toEqual(
        ['run_legacy_local', 'run_session', rows.ptyRunId, rows.structuredRunId].sort()
      )

      v41.exec(
        HANDLE_ONLY_COORDINATOR_TRIGGERS_SQL.replaceAll(
          'CREATE TRIGGER',
          'CREATE TRIGGER IF NOT EXISTS'
        )
      )
      v41
        .prepare(
          `INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key, consumer_generation, legacy)
           VALUES ('run_v41', 'written by v41', 'term_v41', 'tab_v41:44444444-4444-4444-8444-444444444444', 1, 0)`
        )
        .run()
      // An older rebind cannot clear a session-id column it cannot see.
      v41
        .prepare(
          `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
             consumer_generation = consumer_generation + 1, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run('term_taker', PTY_WORKER_PANE, rows.structuredRunId)
      v41.exec(`INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT id, coordinator_handle FROM runs WHERE legacy = 0 AND coordinator_handle IS NOT NULL`)

      const readOrcaSessionId = v41.prepare(
        'SELECT coordinator_orca_session_id FROM runs WHERE id = ?'
      )
      expect(readOrcaSessionId.get('run_v41')).toEqual({ coordinator_orca_session_id: null })
      expect(readOrcaSessionId.get(rows.structuredRunId)).toEqual({
        coordinator_orca_session_id: SESSION_ID
      })
      // The v42 address cache predates the v41 rebind that made its session id stale.
      expect(coordinatorAddresses(v41, ['run_v41', rows.structuredRunId])).toEqual(
        [
          `${rows.structuredRunId} ${rows.workerHandle}`,
          `${rows.structuredRunId} ${formatOrcaSessionAddress(SESSION_ID)}`,
          `${rows.structuredRunId} term_taker`,
          'run_v41 term_v41'
        ].sort()
      )
      for (const sql of coordinatorTriggerSql(v41)) {
        expect(sql).toContain('coordinator_orca_session_id')
      }
    } finally {
      v41.close()
    }

    const rolledForward = new OrchestrationDb(path)
    try {
      expect(rolledForward.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(rolledForward.getRun('run_v41')?.coordinator_handle).toBe('term_v41')
      expect(rolledForward.getRunMailboxOwnerIdsForHandle(CHAT_SESSION_ADDRESS)).toEqual([
        'run_session'
      ])
      // The old rebind bumps generation, invalidating the id it could not clear.
      const rebound = rolledForward.getRunRaw(rows.structuredRunId)
      expect(rebound?.coordinator_orca_session_id).toBe(SESSION_ID)
      expect(rebound && currentRunCoordinatorOrcaSessionId(rebound)).toBeNull()
    } finally {
      rolledForward.close()
    }
  })

  it('fills structured-worker rows written after the stamp reached v42 on the next open', () => {
    const path = tempDbPath()
    const first = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(first)
    first.db.exec(
      'UPDATE dispatch_contexts SET assignee_orca_session_id = NULL, creator_orca_session_id = NULL; UPDATE runs SET coordinator_orca_session_id = NULL'
    )
    expect(
      first.getDispatchContextById(rows.structuredDispatchId)?.assignee_orca_session_id
    ).toBeNull()
    first.close()

    const reopened = new OrchestrationDb(path)
    try {
      expect(
        reopened.getDispatchContextById(rows.structuredDispatchId)?.assignee_orca_session_id
      ).toBe(SESSION_ID)
      expect(reopened.getDispatchContextById(rows.nestedDispatchId)?.creator_orca_session_id).toBe(
        SESSION_ID
      )
      expect(reopened.getRunRaw(rows.structuredRunId)?.coordinator_orca_session_id).toBe(SESSION_ID)
      expect(
        reopened.getDispatchContextById(rows.ptyDispatchId)?.assignee_orca_session_id
      ).toBeNull()
    } finally {
      reopened.close()
    }
  })

  it('drives a dev database stamped v42 with prototype principal columns to add the Orca session ids', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripOrcaSessionSchema(path, 41)
    const raw = new Database(path)
    // Model a dev prototype with stale principal columns and triggers.
    raw.exec(`
      ALTER TABLE runs ADD COLUMN coordinator_principal TEXT;
      ALTER TABLE dispatch_contexts ADD COLUMN assignee_principal TEXT;
      ALTER TABLE dispatch_contexts ADD COLUMN creator_principal TEXT;
      ALTER TABLE worker_terminal_resources ADD COLUMN principal TEXT;
      DROP TRIGGER trg_runs_remember_coordinator_insert;
      DROP TRIGGER trg_runs_remember_coordinator_update;
      CREATE TRIGGER trg_runs_remember_coordinator_insert
      AFTER INSERT ON runs
      WHEN NEW.legacy = 0 AND (NEW.coordinator_handle IS NOT NULL OR NEW.coordinator_principal IS NOT NULL)
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        VALUES (NEW.id, COALESCE(NEW.coordinator_handle, NEW.coordinator_principal));
      END;
      CREATE TRIGGER trg_runs_remember_coordinator_update
      AFTER UPDATE OF coordinator_handle, coordinator_principal ON runs
      WHEN NEW.legacy = 0 AND (NEW.coordinator_handle IS NOT NULL OR NEW.coordinator_principal IS NOT NULL)
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        VALUES (NEW.id, COALESCE(NEW.coordinator_handle, NEW.coordinator_principal));
      END;
    `)
    raw.pragma('user_version = 42')
    try {
      expect(resolveOrchestrationMigrationStartVersion(raw, 42, SCHEMA_VERSION)).toBe(6)
    } finally {
      raw.close()
    }

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(orcaSessionColumns(db.db)).toEqual(ORCA_SESSION_ID_COLUMNS)
      expect(coordinatorTriggerSql(db.db).join('\n')).not.toContain('principal')
      expect(db.getDispatchContextById(rows.structuredDispatchId)?.assignee_orca_session_id).toBe(
        SESSION_ID
      )
      expect(() =>
        db.createRun({
          objective: 'after the replay',
          coordinatorHandle: 'term_after',
          coordinatorPaneKey: 'tab_after:55555555-5555-4555-8555-555555555555'
        })
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it("stops counting a chat coordinator's Orca session id once a v41 binary rebinds and then unbinds the Run", () => {
    const path = tempDbPath()
    const seeded = new OrchestrationDb(path)
    seeded.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_orca_session_id, coordinator_orca_session_id_generation, consumer_generation, legacy
         ) VALUES ('run_chat', 'chat coordinated', ?, 1, 1, 0)`
      )
      .run(CHAT_SESSION_ID)
    // Remove the cached address to prove reopening cannot resurrect it.
    seeded.db.prepare('DELETE FROM run_coordinator_handles WHERE run_id = ?').run('run_chat')
    seeded.close()

    const v41 = new Database(path)
    v41
      .prepare(
        `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run('term_taker', PTY_WORKER_PANE, 'run_chat')
    v41
      .prepare(
        `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run('run_chat')
    // Without its generation fence, this stale id is indistinguishable from a live chat binding.
    expect(
      v41
        .prepare(
          `SELECT coordinator_handle, coordinator_pane_key, coordinator_orca_session_id,
             consumer_generation
           FROM runs WHERE id = ?`
        )
        .get('run_chat')
    ).toEqual({
      coordinator_handle: null,
      coordinator_pane_key: null,
      coordinator_orca_session_id: CHAT_SESSION_ID,
      consumer_generation: 3
    })
    v41.close()

    const reopened = new OrchestrationDb(path)
    try {
      const run = reopened.getRunRaw('run_chat')
      expect(run && currentRunCoordinatorOrcaSessionId(run)).toBeNull()
      expect(
        reopened.db
          .prepare(`SELECT id FROM runs WHERE ${currentRunCoordinatorOrcaSessionIdSql('runs')} = ?`)
          .all(CHAT_SESSION_ID)
      ).toEqual([])
      expect(coordinatorAddresses(reopened.db, ['run_chat'])).toEqual(['run_chat term_taker'])
    } finally {
      reopened.close()
    }
  })

  it('finds Runs by coordinator Orca session id through an index on fresh and upgraded databases', () => {
    const expectIndexedLookup = (path: string): void => {
      const db = new OrchestrationDb(path)
      try {
        const plan = coordinatorLookupPlan(db.db)
        expect(plan).toContain('USING INDEX idx_runs_coordinator_orca_session_id')
        expect(plan).not.toContain('SCAN runs')
      } finally {
        db.close()
      }
    }
    expectIndexedLookup(tempDbPath())

    const upgradedPath = tempDbPath()
    const seed = new OrchestrationDb(upgradedPath)
    seedStructuredAndPtyRows(seed)
    seed.close()
    stripOrcaSessionSchema(upgradedPath, 41)
    expectIndexedLookup(upgradedPath)
  })

  it('replays a dev database stamped v42 with the earlier *_actor columns to add the Orca session ids', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripOrcaSessionSchema(path, 41)
    const raw = new Database(path)
    // Model earlier v42 actor columns, indexes and triggers containing session: addresses.
    const earlierAddress = `COALESCE(NEW.coordinator_handle, (CASE WHEN
      NEW.coordinator_actor_generation = NEW.consumer_generation THEN NEW.coordinator_actor END))`
    raw.exec(`
      ALTER TABLE runs ADD COLUMN coordinator_actor TEXT;
      ALTER TABLE runs ADD COLUMN coordinator_actor_generation INTEGER;
      ALTER TABLE dispatch_contexts ADD COLUMN assignee_actor TEXT;
      ALTER TABLE dispatch_contexts ADD COLUMN creator_actor TEXT;
      CREATE INDEX idx_runs_coordinator_actor
        ON runs(coordinator_actor) WHERE coordinator_actor IS NOT NULL;
      CREATE INDEX idx_dispatch_assignee_actor
        ON dispatch_contexts(assignee_actor) WHERE assignee_actor IS NOT NULL;
      DROP TRIGGER trg_runs_remember_coordinator_insert;
      DROP TRIGGER trg_runs_remember_coordinator_update;
      CREATE TRIGGER trg_runs_remember_coordinator_insert
      AFTER INSERT ON runs
      WHEN NEW.legacy = 0 AND ${earlierAddress} IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        VALUES (NEW.id, ${earlierAddress});
      END;
      CREATE TRIGGER trg_runs_remember_coordinator_update
      AFTER UPDATE OF coordinator_handle, coordinator_actor, coordinator_actor_generation ON runs
      WHEN NEW.legacy = 0 AND ${earlierAddress} IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        VALUES (NEW.id, ${earlierAddress});
      END;
    `)
    raw
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_actor, coordinator_actor_generation, consumer_generation, legacy
         ) VALUES ('run_earlier_chat', 'chat coordinated', ?, 1, 1, 0)`
      )
      .run(CHAT_SESSION_ADDRESS)
    // Remove the cache entry so only the obsolete column could resurrect it.
    raw.prepare('DELETE FROM run_coordinator_handles WHERE run_id = ?').run('run_earlier_chat')
    raw.pragma('user_version = 42')
    try {
      expect(resolveOrchestrationMigrationStartVersion(raw, 42, SCHEMA_VERSION)).toBe(6)
    } finally {
      raw.close()
    }

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(orcaSessionColumns(db.db)).toEqual(ORCA_SESSION_ID_COLUMNS)
      for (const sql of coordinatorTriggerSql(db.db)) {
        expect(sql).toContain(
          'NEW.coordinator_orca_session_id_generation = NEW.consumer_generation'
        )
        expect(sql).not.toContain('coordinator_actor')
      }
      expect(db.getDispatchContextById(rows.structuredDispatchId)?.assignee_orca_session_id).toBe(
        SESSION_ID
      )
      const run = db.getRunRaw(rows.structuredRunId)
      expect(run && currentRunCoordinatorOrcaSessionId(run)).toBe(SESSION_ID)
      expect(
        db.db
          .prepare('SELECT coordinator_actor, coordinator_orca_session_id FROM runs WHERE id = ?')
          .get('run_earlier_chat')
      ).toEqual({ coordinator_actor: CHAT_SESSION_ADDRESS, coordinator_orca_session_id: null })
      expect(coordinatorAddresses(db.db, ['run_earlier_chat'])).toEqual([])
      expect(() =>
        db.createRun({
          objective: 'after the replay',
          coordinatorHandle: 'term_after',
          coordinatorPaneKey: 'tab_after:55555555-5555-4555-8555-555555555555'
        })
      ).not.toThrow()
    } finally {
      db.close()
    }
  })
})
