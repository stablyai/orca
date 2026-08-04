// Candidate-store ownership stays with Phase 8 (Phase 10).
//
// THE PROPERTY THIS FILE EXISTS TO PIN: Phase 8 releases candidate stores when
// the task reaches `committed`, and landing is reachable only FROM `committed`.
// The land lane therefore performs NO routine cleanup — its single call is an
// explicitly-labelled ORPHAN SWEEP that must select zero rows on the normal path.
//
// If this file ever starts asserting that the normal path releases rows, Phase 10
// has silently become a second owner of Phase 8's responsibility.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuditedWorkflowTables } from './audited-task-schema'
import { releaseTaskStoresAndDelete } from './audited-candidate-store-gc'
import Database from '../sqlite/sync-database'

const TREE = 'a'.repeat(40)

function seedCandidate(db: Database.Database, options: { storeBytes: number | null }): void {
  db.prepare(
    `INSERT INTO audited_tasks
       (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
        state, created_at_ms, updated_at_ms)
     VALUES ('task1','repo1','/repo',?, 'local','t','{}','custom','low','committed',1,1)`
  ).run('b'.repeat(40))
  db.prepare(
    `INSERT INTO audited_candidates
       (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name,
        store_bytes, created_at_ms)
     VALUES ('cand_1','task1','run_1',0,'current',?,?, 'feature', ?, 1)`
  ).run(TREE, 'b'.repeat(40), options.storeBytes)
}

describe('the normal committed -> landed path releases NOTHING', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
  })

  afterEach(() => db.close())

  it('selects zero rows once Phase 8 has already cleared store_bytes', () => {
    // This is what a task looks like AFTER startCommit released its stores.
    seedCandidate(db, { storeBytes: null })
    const result = releaseTaskStoresAndDelete(db, 'task1', '/tmp/userdata-nonexistent')
    expect(result.released).toBe(0)
    expect(result.deletionFailures).toBe(0)
  })

  it('releases exactly one row for a genuine ORPHAN from an older build', () => {
    seedCandidate(db, { storeBytes: 4096 })
    const result = releaseTaskStoresAndDelete(db, 'task1', '/tmp/userdata-nonexistent')
    expect(result.released).toBe(1)
  })

  it('is idempotent — a second call is a no-op', () => {
    seedCandidate(db, { storeBytes: 4096 })
    expect(releaseTaskStoresAndDelete(db, 'task1', '/tmp/userdata-nonexistent').released).toBe(1)
    expect(releaseTaskStoresAndDelete(db, 'task1', '/tmp/userdata-nonexistent').released).toBe(0)
  })

  it('clears store accounting so the row can never be released twice', () => {
    seedCandidate(db, { storeBytes: 4096 })
    releaseTaskStoresAndDelete(db, 'task1', '/tmp/userdata-nonexistent')
    const row = db.prepare(`SELECT store_bytes FROM audited_candidates WHERE id='cand_1'`).get() as
      | { store_bytes: number | null }
      | undefined
    expect(row?.store_bytes).toBeNull()
  })

  it('reports a deletion failure inertly rather than throwing', () => {
    seedCandidate(db, { storeBytes: 4096 })
    // A userData path that cannot host the directory still must not throw: the
    // land is durable and terminal by the time this runs.
    expect(() => releaseTaskStoresAndDelete(db, 'task1', '/tmp/userdata-nonexistent')).not.toThrow()
  })
})
