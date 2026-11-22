import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../../../sqlite/sync-database'
import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  readRetainedPlacementCatalog,
  writeRetainedPlacementCatalog
} from '../remote-owned/worker-placement-catalog-store'

const V50_INDEXES = [
  'idx_bot_requests_awaiting',
  'idx_question_threads_awaiting',
  'idx_remote_owned_questions_awaiting',
  'idx_dispatch_contexts_for_message',
  'idx_peer_questions_out_awaiting'
]
const V50_COLUMNS = [
  ['bot_requests', 'taken_by'],
  ['bot_requests', 'awaiting'],
  ['question_threads', 'taken_by'],
  ['question_threads', 'awaiting'],
  ['question_threads', 'told'],
  ['remote_owned_questions', 'taken_by'],
  ['remote_owned_questions', 'awaiting'],
  ['remote_owned_questions', 'ended'],
  ['dispatch_contexts', 'for_message_id']
] as const
const pin = {
  environment_id: 'server',
  peer_fingerprint: 'peer',
  home_fingerprint: 'home',
  pairing_revision: 1
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A database last opened at `version`: v50 records who took questions; the catalog table came later. */
function databaseAt(version: 49 | 50): string {
  // Use a real temp directory: TMPDIR is absent on Windows CI.
  const root = mkdtempSync(join(tmpdir(), 'orca-placement-migration-'))
  roots.push(root)
  const path = join(root, 'orchestration.db')
  new OrchestrationDb(path).close()
  const raw = new Database(path)
  raw.exec('DROP TABLE worker_placement_catalogs')
  if (version === 49) {
    for (const index of V50_INDEXES) {
      raw.exec(`DROP INDEX ${index}`)
    }
    for (const [table, column] of V50_COLUMNS) {
      raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    }
    raw.exec('DROP TABLE peer_questions_out')
  }
  raw.pragma(`user_version = ${version}`)
  raw.close()
  return path
}

it.each([49, 50] as const)(
  'upgrades a v%i database with both the question columns and the catalog table',
  (version) => {
    const db = new OrchestrationDb(databaseAt(version))
    try {
      expect(V50_COLUMNS.filter(([table, column]) => !db.hasColumn(table, column))).toEqual([])
      expect(
        db.db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'
             AND name IN ('peer_questions_out', 'worker_placement_catalogs') ORDER BY name`
          )
          .all()
      ).toEqual([{ name: 'peer_questions_out' }, { name: 'worker_placement_catalogs' }])
      const value = { observedAt: 1000, catalog: { repos: [], setups: [] } }
      expect(writeRetainedPlacementCatalog(db, pin, null, value)).toBeTruthy()
      expect(readRetainedPlacementCatalog(db, pin)).toMatchObject({ value })
    } finally {
      db.close()
    }
  }
)
