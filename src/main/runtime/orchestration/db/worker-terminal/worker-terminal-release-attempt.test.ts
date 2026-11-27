import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import {
  installWorkerTerminalReleaseAttempts,
  readWorkerTerminalReleaseAttempt
} from './worker-terminal-release-attempt'
import {
  deleteExpiredOrchestrationRows,
  EXPIRED_ROW_SWEEPS
} from '../maintenance/settled-run-retention'
import { retireSettledRun, type RunPartyLiveness } from '../maintenance/settled-run-retirement'

const LONG_AGO = '2000-01-01 00:00:00'
const PANE_LEAF = '11111111-1111-4111-8111-111111111111'
const TRIGGER = 'trg_worker_terminal_release_attempts_delete'
const nobodyIsLive: RunPartyLiveness = {
  isLiveHandle: () => false,
  isLivePane: () => false,
  waitedMailboxes: () => []
}

type Sqlite = OrchestrationDb['db']

const revisions = (db: Sqlite) =>
  db
    .prepare(
      'SELECT resource_id, attempt FROM worker_terminal_release_attempts ORDER BY resource_id'
    )
    .all()
const triggerSql = (db: Sqlite) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").all(TRIGGER)
const tableCount = (db: Sqlite) =>
  Number(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'worker_terminal_release_attempts'"
      )
      .get()?.n
  )
const deleteResource = (db: Sqlite, id: string) =>
  db.prepare('DELETE FROM worker_terminal_resources WHERE id = ?').run(id)

/** A Run whose worker terminal the coordinator kept open once, through the real retain. */
function keptOpenWorker(db: OrchestrationDb, name: string) {
  const run = db.createRun({
    objective: name,
    coordinatorHandle: `term_${name}`,
    coordinatorPaneKey: `tab_${name}:${PANE_LEAF}`
  })
  const task = db.createTask({ spec: 'work', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  const resourceId = `resource_${name}`
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, ownership_state, release_state)
       VALUES (?, ?, ?, ?, 'owned', 'not_requested')`
    )
    .run(resourceId, dispatch.id, dispatch.id, `term_worker_${name}`)
  expect(db.retainWorkerTerminalResource(dispatch.id).disposition).toBe('retained')
  expect(readWorkerTerminalReleaseAttempt(db, resourceId)).toBe(1)
  return { runId: run.id, taskId: task.id, dispatchId: dispatch.id, resourceId }
}

describe('keep-open revisions', () => {
  const dirs: string[] = []
  const open: { close(): void }[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of open.splice(0)) {
      db.close()
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function file(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'release-attempts-'))
    dirs.push(dir)
    return path.join(dir, 'orchestration.db')
  }
  function openDb(at = ':memory:'): OrchestrationDb {
    const db = new OrchestrationDb(at)
    open.push(db)
    return db
  }
  function closeDb(db: { close(): void }): void {
    open.splice(open.indexOf(db), 1)
    db.close()
  }
  function rawDb(at: string): Sqlite {
    const db = new Database(at)
    open.push(db)
    return db
  }
  const canonicalTrigger = () => triggerSql(openDb().db)

  describe('installer', () => {
    it('leaves one table and the current trigger on a fresh, an existing and a reopened file', () => {
      const at = file()
      const canonical = canonicalTrigger()
      expect(canonical).toHaveLength(1)
      for (let opening = 0; opening < 3; opening++) {
        const db = openDb(at)
        expect(tableCount(db.db)).toBe(1)
        expect(triggerSql(db.db)).toEqual(canonical)
        expect(readWorkerTerminalReleaseAttempt(db, 'never_kept')).toBe(0)
        closeDb(db)
      }
    })

    for (const damage of ['missing', 'wrong_body'] as const) {
      it(`restores a ${damage} trigger and sweeps the revisions stranded meanwhile`, () => {
        const at = file()
        const seeded = openDb(at)
        const neighbour = keptOpenWorker(seeded, 'neighbour')
        closeDb(seeded)
        const raw = rawDb(at)
        raw.exec(`DROP TRIGGER ${TRIGGER}`)
        if (damage === 'wrong_body') {
          raw.exec(`CREATE TRIGGER ${TRIGGER} AFTER DELETE ON worker_terminal_resources
            BEGIN SELECT 1; END`)
        }
        raw.prepare('INSERT INTO worker_terminal_release_attempts VALUES (?, 7)').run('orphan')
        closeDb(raw)

        const db = openDb(at)

        expect(triggerSql(db.db)).toEqual(canonicalTrigger())
        expect(revisions(db.db)).toEqual([{ resource_id: neighbour.resourceId, attempt: 1 }])
        deleteResource(db.db, neighbour.resourceId)
        expect(revisions(db.db)).toEqual([])
      })
    }

    it('takes no lock, runs no DDL and sweeps nothing when the stored trigger matches', () => {
      const at = file()
      closeDb(openDb(at))
      const raw = rawDb(at)
      raw.prepare('INSERT INTO worker_terminal_release_attempts VALUES (?, 7)').run('orphan')
      closeDb(raw)

      const db = openDb(at)
      expect(revisions(db.db)).toEqual([{ resource_id: 'orphan', attempt: 7 }])
      const exec = vi.spyOn(db.db, 'exec')
      installWorkerTerminalReleaseAttempts(db)
      expect(exec).not.toHaveBeenCalled()
      expect(revisions(db.db)).toEqual([{ resource_id: 'orphan', attempt: 7 }])
    })
  })

  describe('a revision lives exactly as long as its resource', () => {
    for (const reset of ['resetAll', 'resetTasks'] as const) {
      it(`goes with its resource on ${reset}`, () => {
        const db = openDb()
        keptOpenWorker(db, 'reset')
        db[reset]()
        expect(revisions(db.db)).toEqual([])
      })
    }

    it("goes with its resource when settled-Run retirement pages through the Run's rows", () => {
      const db = openDb()
      const retiring = keptOpenWorker(db, 'retiring')
      const neighbour = keptOpenWorker(db, 'neighbour')
      // Released later, then the Run settles and ages out.
      db.db
        .prepare(
          "UPDATE worker_terminal_resources SET release_state = 'released', ownership_state = 'released' WHERE id = ?"
        )
        .run(retiring.resourceId)
      db.db.prepare("UPDATE tasks SET status = 'completed' WHERE run_id = ?").run(retiring.runId)
      db.db
        .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE run_id = ?")
        .run(retiring.runId)
      db.db
        .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
        .run(retiring.dispatchId)
      for (const row of db.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()) {
        const table = String(row.name)
        for (const column of db.db.prepare(`PRAGMA table_info(${table})`).all()) {
          const name = String(column.name)
          if (name.endsWith('_at')) {
            db.db.exec(`UPDATE ${table} SET ${name} = '${LONG_AGO}' WHERE ${name} IS NOT NULL`)
          }
        }
      }

      const steps = retireSettledRun(db, retiring.runId, nobodyIsLive)
      let pagedAway = false
      for (let step = steps.next(); !step.done; step = steps.next()) {
        const resourceLeft = db.getWorkerTerminalResource(retiring.resourceId) !== undefined
        const revisionLeft = revisions(db.db).some((row) => row.resource_id === retiring.resourceId)
        expect(revisionLeft).toBe(resourceLeft)
        if (!resourceLeft && db.getRun(retiring.runId)) {
          pagedAway = true
        }
      }

      expect(pagedAway).toBe(true)
      expect(db.getRun(retiring.runId)).toBeUndefined()
      expect(revisions(db.db)).toEqual([{ resource_id: neighbour.resourceId, attempt: 1 }])
    })

    it('goes with its resource when the expired-row sweep removes a resource whose Dispatch is gone', () => {
      const db = openDb()
      const expired = keptOpenWorker(db, 'expired')
      const neighbour = keptOpenWorker(db, 'neighbour')
      db.db.prepare('DELETE FROM dispatch_contexts WHERE id = ?').run(expired.dispatchId)
      db.db
        .prepare('UPDATE worker_terminal_resources SET updated_at = ? WHERE id = ?')
        .run(LONG_AGO, expired.resourceId)

      for (let sweep = 0; sweep < EXPIRED_ROW_SWEEPS; sweep++) {
        for (let after: number | null = 0; after !== null;) {
          after = deleteExpiredOrchestrationRows(db, sweep, after, 2)
        }
      }

      expect(db.getWorkerTerminalResource(expired.resourceId)).toBeUndefined()
      expect(revisions(db.db)).toEqual([{ resource_id: neighbour.resourceId, attempt: 1 }])
    })

    it('comes back with its resource when the delete rolls back', () => {
      const db = openDb()
      const kept = keptOpenWorker(db, 'kept')
      db.db.exec('BEGIN IMMEDIATE')
      deleteResource(db.db, kept.resourceId)
      expect(revisions(db.db)).toEqual([])
      db.db.exec('ROLLBACK')

      expect(db.getWorkerTerminalResource(kept.resourceId)).toBeDefined()
      expect(revisions(db.db)).toEqual([{ resource_id: kept.resourceId, attempt: 1 }])
    })

    it('goes with its resource when a connection that installs nothing deletes it', () => {
      const at = file()
      const seeded = openDb(at)
      const gone = keptOpenWorker(seeded, 'gone')
      const neighbour = keptOpenWorker(seeded, 'neighbour')
      closeDb(seeded)

      // Stands in for an older build: it opens the file and knows nothing of revisions.
      const older = rawDb(at)
      deleteResource(older, gone.resourceId)

      expect(revisions(older)).toEqual([{ resource_id: neighbour.resourceId, attempt: 1 }])
    })
  })
})
