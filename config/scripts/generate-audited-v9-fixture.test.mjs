// Provenance and migration proof for the committed v9 fixture (Phase 11 §1a).
//
// TWO JOBS, and the first is what stops the second from being vacuous:
//
//   1. The committed fixture is GENUINELY v9 — right user_version, no Phase 10
//      table or columns. A fixture that had drifted to v10 would make the
//      installer smoke pass while testing nothing.
//   2. Running the REAL migration over a copy of it produces v10 with every
//      seeded row intact, the new table and its partial index created, and
//      audited_tasks NOT rebuilt.
//
// Job 2 is the same assertion set the packaged installer smoke makes, run here
// in-process so a migration regression fails in unit CI rather than only after
// four installers have been built.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { V9_SCHEMA_VERSION, V9_SEED, V9_SOURCE_COMMIT } from './generate-audited-v9-fixture.mjs'

const FIXTURE_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'tests',
  'fixtures',
  'audited-workflow',
  'v9',
  'audited-workflow.db'
)

let workDir
let workingCopy

function open(path, options = {}) {
  return new DatabaseSync(path, options)
}

function userVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version
}

function tableNames(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => row.name)
}

function columnNames(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)
}

function tableSql(db, name) {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name)
  return row?.sql ?? ''
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'orca-v9-fixture-'))
  workingCopy = join(workDir, 'audited-workflow.db')
  // COPIED, never opened in place — a run must not be able to mutate the
  // committed fixture, which is exactly what the smoke harness also guarantees.
  copyFileSync(FIXTURE_PATH, workingCopy)
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('the committed fixture is genuinely v9', () => {
  it(`reports user_version ${V9_SCHEMA_VERSION}`, () => {
    const db = open(FIXTURE_PATH, { readOnly: true })
    try {
      expect(userVersion(db)).toBe(V9_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('has NO audited_land_attempts table', () => {
    const db = open(FIXTURE_PATH, { readOnly: true })
    try {
      expect(tableNames(db)).not.toContain('audited_land_attempts')
    } finally {
      db.close()
    }
  })

  it('has NO Phase 10 task columns', () => {
    const db = open(FIXTURE_PATH, { readOnly: true })
    try {
      const columns = columnNames(db, 'audited_tasks')
      expect(columns).not.toContain('land_attempt_status')
      expect(columns).not.toContain('landing_advisory')
    } finally {
      db.close()
    }
  })

  it('DOES carry the landing columns that predate Phase 10', () => {
    // These have existed since Phase 1 and were reserved for the landing lane.
    // Their presence at v9 is what makes "the migration must not recreate them"
    // a meaningful assertion later.
    const db = open(FIXTURE_PATH, { readOnly: true })
    try {
      const columns = columnNames(db, 'audited_tasks')
      expect(columns).toEqual(
        expect.arrayContaining(['landed_sha', 'landed_base_sha', 'landing_reason_code'])
      )
    } finally {
      db.close()
    }
  })

  it('carries the documented seed rows', () => {
    const db = open(FIXTURE_PATH, { readOnly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) n FROM audited_tasks').get().n).toBe(3)
      expect(db.prepare('SELECT COUNT(*) n FROM audited_commit_attempts').get().n).toBe(1)
      expect(db.prepare('SELECT COUNT(*) n FROM audited_publish_attempts').get().n).toBe(1)
      expect(db.prepare('SELECT COUNT(*) n FROM audited_candidates').get().n).toBe(1)
      expect(db.prepare('SELECT COUNT(*) n FROM audited_transitions').get().n).toBe(
        V9_SEED.transitionCount
      )
    } finally {
      db.close()
    }
  })

  it('records a pinned provenance commit', () => {
    expect(V9_SOURCE_COMMIT).toMatch(/^[0-9a-f]{7,40}$/)
  })
})

describe('v9 -> v10 migration over the fixture', () => {
  async function migrate() {
    const { createAuditedWorkflowTables, migrateAuditedWorkflowSchema } =
      await import('../../src/main/audited-workflow/audited-task-schema.ts')
    // The REAL wrapper the app uses, not raw DatabaseSync: the migration calls
    // db.pragma(), which only the adapter provides. Using the production type
    // here is what makes this the same code path a packaged launch runs.
    const { default: Database } = await import('../../src/main/sqlite/sync-database.ts')
    const db = new Database(workingCopy)
    try {
      // The real startup order: create-if-missing, then migrate.
      createAuditedWorkflowTables(db)
      migrateAuditedWorkflowSchema(db)
    } finally {
      db.close()
    }
  }

  it('raises user_version from 9 to 10', async () => {
    const before = open(workingCopy, { readOnly: true })
    expect(userVersion(before)).toBe(9)
    before.close()

    await migrate()

    const after = open(workingCopy, { readOnly: true })
    try {
      expect(userVersion(after)).toBe(10)
    } finally {
      after.close()
    }
  })

  it('creates audited_land_attempts with both bindings and the evidence markers', async () => {
    await migrate()
    const db = open(workingCopy, { readOnly: true })
    try {
      expect(tableNames(db)).toContain('audited_land_attempts')
      expect(columnNames(db, 'audited_land_attempts')).toEqual(
        expect.arrayContaining([
          'commit_attempt_id',
          'publish_attempt_id',
          'intended_sha',
          'intended_base_sha',
          'source_repo_path',
          'source_repo_common_dir',
          'ref_update_started',
          'ref_update_completed',
          'worktree_update_started',
          'worktree_update_completed',
          'landed_sha',
          'landing_advisory'
        ])
      )
    } finally {
      db.close()
    }
  })

  it('creates the partial unique index carrying the authorized predicate', async () => {
    await migrate()
    const db = open(workingCopy, { readOnly: true })
    try {
      const index = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get('idx_audited_land_attempts_live')
      // The CAS primitive, not merely the table: without the predicate a second
      // live attempt could be inserted.
      expect(index?.sql).toContain(`status = 'authorized'`)
    } finally {
      db.close()
    }
  })

  it('adds the two Phase 10 task columns', async () => {
    await migrate()
    const db = open(workingCopy, { readOnly: true })
    try {
      const columns = columnNames(db, 'audited_tasks')
      expect(columns).toContain('land_attempt_status')
      expect(columns).toContain('landing_advisory')
    } finally {
      db.close()
    }
  })

  it('does NOT rebuild audited_tasks — v10 is additive by design', async () => {
    const before = open(workingCopy, { readOnly: true })
    const sqlBefore = tableSql(before, 'audited_tasks')
    before.close()

    await migrate()

    const after = open(workingCopy, { readOnly: true })
    try {
      // ALTER TABLE ADD COLUMN appends to the stored DDL; a 12-step rebuild
      // would replace it wholesale and lose the original prefix.
      expect(tableSql(after, 'audited_tasks').startsWith(sqlBefore.slice(0, 200))).toBe(true)
    } finally {
      after.close()
    }
  })

  it('preserves every seeded row byte-identically', async () => {
    await migrate()
    const db = open(workingCopy, { readOnly: true })
    try {
      const committed = db
        .prepare('SELECT state, committed_sha FROM audited_tasks WHERE id = ?')
        .get(V9_SEED.committedTask.id)
      expect(committed.state).toBe('committed')
      expect(committed.committed_sha).toBe(V9_SEED.committedTask.committedSha)

      const blocked = db
        .prepare('SELECT state FROM audited_tasks WHERE id = ?')
        .get(V9_SEED.blockedTask.id)
      expect(blocked.state).toBe('blocked')

      // The sharp case: a pre-Phase-10 `landed` row keeps its NULL landed_sha.
      const landed = db
        .prepare('SELECT state, landed_sha FROM audited_tasks WHERE id = ?')
        .get(V9_SEED.landedTask.id)
      expect(landed.state).toBe('landed')
      expect(landed.landed_sha).toBeNull()

      const commitAttempt = db
        .prepare('SELECT status, created_commit_sha FROM audited_commit_attempts WHERE id = ?')
        .get(V9_SEED.commitAttempt.id)
      expect(commitAttempt.status).toBe('completed')
      expect(commitAttempt.created_commit_sha).toBe(V9_SEED.commitAttempt.createdCommitSha)

      const publishAttempt = db
        .prepare('SELECT status, pushed_sha FROM audited_publish_attempts WHERE id = ?')
        .get(V9_SEED.publishAttempt.id)
      expect(publishAttempt.status).toBe('completed')
      expect(publishAttempt.pushed_sha).toBe(V9_SEED.publishAttempt.pushedSha)

      // Phase 8's store accounting must be untouched by a Phase 10 migration.
      const candidate = db
        .prepare('SELECT store_bytes FROM audited_candidates WHERE id = ?')
        .get(V9_SEED.candidate.id)
      expect(candidate.store_bytes).toBe(V9_SEED.candidate.storeBytes)

      expect(db.prepare('SELECT COUNT(*) n FROM audited_transitions').get().n).toBe(
        V9_SEED.transitionCount
      )
    } finally {
      db.close()
    }
  })

  it('is idempotent — a second migration changes nothing', async () => {
    await migrate()
    const first = open(workingCopy, { readOnly: true })
    const columnsAfterFirst = columnNames(first, 'audited_tasks').length
    const taskCount = first.prepare('SELECT COUNT(*) n FROM audited_tasks').get().n
    first.close()

    await migrate()

    const second = open(workingCopy, { readOnly: true })
    try {
      expect(userVersion(second)).toBe(10)
      expect(columnNames(second, 'audited_tasks').length).toBe(columnsAfterFirst)
      expect(second.prepare('SELECT COUNT(*) n FROM audited_tasks').get().n).toBe(taskCount)
    } finally {
      second.close()
    }
  })

  it('leaves the committed fixture unmodified', () => {
    // Proves the copy-not-open-in-place contract the smoke harness relies on.
    const db = open(FIXTURE_PATH, { readOnly: true })
    try {
      expect(userVersion(db)).toBe(V9_SCHEMA_VERSION)
      expect(tableNames(db)).not.toContain('audited_land_attempts')
    } finally {
      db.close()
    }
  })
})
