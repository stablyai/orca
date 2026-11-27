import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { dropDerivedDeliverySchema } from './derived-delivery-test-fixture'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

// Main shipped v52 as the progress columns; earlier sharing builds stamped v52 with acts_for only.
const SHAPES = {
  'main v52': { version: 52, drop: ['acts_for'], resumesAt: 52 },
  'sharing v52': { version: 52, drop: ['progress_note', 'progress_updated_at'], resumesAt: 51 },
  v51: { version: 51, drop: ['acts_for', 'progress_note', 'progress_updated_at'], resumesAt: 51 },
  'v53 without acts_for': { version: 53, drop: ['acts_for'], resumesAt: 52 }
} as const

describe('opening a v51-v53 database from main or an earlier sharing build', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  /** A live database: a real Run, a Dispatch with every v51+ value set, and two outstanding
   *  deliveries for one mailbox (a read-but-unacked batch beside a new one, allowed since v41). */
  function seed(): { path: string; dispatchId: string; runId: string } {
    const directory = mkdtempSync(join(tmpdir(), 'orca-v52-fork-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    const db = new OrchestrationDb(path)
    const run = db.createRun({
      objective: 'live',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ runId: run.id, spec: 'live task' })
    const dispatch = createRootDispatch(db, task.id, 'term_live')
    db.close()
    const raw = new Database(path)
    dropDerivedDeliverySchema(raw)
    raw
      .prepare(
        `UPDATE dispatch_contexts SET chat_lineage = 1, acts_for = '[{"person":"alice"}]',
          progress_note = 'halfway', progress_updated_at = '2026-11-20 00:00:00' WHERE id = ?`
      )
      .run(dispatch.id)
    raw.exec(`
      INSERT INTO deliveries (id, run_id, mailbox_handle, consumer_generation, message_ids, status)
      VALUES ('read_batch', '${run.id}', 'run:${run.id}', 1, '["m1"]', 'outstanding'),
             ('new_batch', '${run.id}', 'run:${run.id}', 1, '["m2"]', 'outstanding');
    `)
    raw.close()
    return { path, dispatchId: dispatch.id, runId: run.id }
  }

  function shape(path: string, version: number, drop: readonly string[]): void {
    const raw = new Database(path)
    dropDerivedDeliverySchema(raw)
    for (const column of drop) {
      raw.exec(`ALTER TABLE dispatch_contexts DROP COLUMN ${column}`)
    }
    raw.pragma(`user_version = ${version}`)
    raw.close()
  }

  for (const [name, { version, drop, resumesAt }] of Object.entries(SHAPES)) {
    it(`adds only what a ${name} database lacks and keeps its rows`, () => {
      const { path, dispatchId, runId } = seed()
      shape(path, version, drop)
      const raw = new Database(path)
      expect(resolveOrchestrationMigrationStartVersion(raw, version, 53)).toBe(resumesAt)
      raw.close()

      const db = new OrchestrationDb(path)
      try {
        expect(db.db.pragma('user_version', { simple: true })).toBe(53)
        const row = db.getDispatchContextById(dispatchId)!
        const dropped: readonly string[] = drop
        const kept = (column: string, value: unknown): unknown =>
          dropped.includes(column) ? null : value
        expect(row).toMatchObject({
          id: dispatchId,
          assignee_handle: 'term_live',
          chat_lineage: 1,
          acts_for: kept('acts_for', '[{"person":"alice"}]'),
          progress_note: kept('progress_note', 'halfway'),
          progress_updated_at: kept('progress_updated_at', '2026-11-20 00:00:00')
        })
        expect(
          db.db.prepare('SELECT id, status FROM deliveries WHERE run_id = ? ORDER BY id').all(runId)
        ).toEqual([
          { id: 'new_batch', status: 'outstanding' },
          { id: 'read_batch', status: 'outstanding' }
        ])
      } finally {
        db.close()
      }
    })
  }
})
