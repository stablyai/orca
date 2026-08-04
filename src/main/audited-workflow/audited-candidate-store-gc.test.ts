// Phase 8 §0.3 — lifecycle, retention, and the transactional accounting release.
//
// The defect these tests exist to prevent: tying accounting release to filesystem
// deletion SUCCEEDING. Deletion is not transactional, so one stuck directory
// would otherwise consume global budget forever.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CANDIDATE_STORE_RETENTION_TTL_MS } from '../../shared/audited-commit-types'
import { createAuditedWorkflowTables } from './audited-task-schema'
import { readChargedBytes, reserveStoreBytes } from './audited-candidate-store-reservation'
import {
  releaseTaskStoresAndDelete,
  sweepCandidateStoresOnStartup
} from './audited-candidate-store-gc'
import { getCandidateStoreRoot } from './audited-candidate-object-store'
import { createTestRepo, type TestRepo } from './audited-worktree-test-repo'
import Database from '../sqlite/sync-database'

const NOW = 1_000_000

function seedTask(db: Database.Database, taskId: string, state: string): void {
  db.prepare(
    `INSERT INTO audited_tasks
       (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source,
        risk, state, created_at_ms, updated_at_ms)
     VALUES (?, 'repo1', '/repo', ?, 'local', 't', '{}', 'custom', 'low', ?, 1, 1)`
  ).run(taskId, 'a'.repeat(40), state)
}

function seedCandidate(
  db: Database.Database,
  args: {
    id: string
    taskId: string
    status: string
    bytes: number | null
    expiresAt: number | null
  }
): void {
  db.prepare(
    `INSERT INTO audited_candidates
       (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name,
        store_bytes, store_expires_at_ms, created_at_ms)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'b', ?, ?, 1)`
  ).run(
    args.id,
    args.taskId,
    `run_${args.id}`,
    args.status,
    'c'.repeat(40),
    'a'.repeat(40),
    args.bytes,
    args.expiresAt
  )
}

function makeStoreDir(userDataPath: string, candidateId: string): string {
  const dir = join(getCandidateStoreRoot(userDataPath), candidateId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'marker'), 'x')
  return dir
}

describe('candidate store GC', () => {
  let db: Database.Database
  let repo: TestRepo
  let userDataPath: string

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    repo = createTestRepo()
    userDataPath = join(repo.workspaceRoot, 'userdata')
    mkdirSync(getCandidateStoreRoot(userDataPath), { recursive: true })
  })

  afterEach(() => {
    db.close()
    repo.cleanup()
  })

  // 10g13 — accounting is released even when deletion fails (terminal path).
  //
  // The failure is induced for real rather than mocked: a directory that cannot
  // be removed is exactly the production condition (locked file, antivirus,
  // permissions), and asserting against it proves the ordering rather than the
  // mock. `rmSync` is not spyable under ESM anyway.
  it('releases accounting on terminal completion even when deletion fails', () => {
    seedTask(db, 'task1', 'committed')
    const candidateId = `cand_${'1'.repeat(32)}`
    seedCandidate(db, {
      id: candidateId,
      taskId: 'task1',
      status: 'current',
      bytes: 500,
      expiresAt: NOW
    })
    makeStoreDir(userDataPath, candidateId)
    expect(readChargedBytes(db)).toBe(500)

    // Point the deletion at a path it cannot remove, so removeCandidateStoreDir
    // reports failure while the DB work has already committed.
    const unremovable = join(userDataPath, 'no-such-root')
    const result = releaseTaskStoresAndDelete(db, 'task1', unremovable)

    // THE ASSERTION THAT MATTERS: the budget is free regardless of the
    // filesystem outcome, because nulling the column IS the release.
    expect(readChargedBytes(db)).toBe(0)
    expect(result.released).toBe(1)
    const row = db
      .prepare(`SELECT store_bytes, store_expires_at_ms FROM audited_candidates WHERE id = ?`)
      .get(candidateId) as { store_bytes: number | null; store_expires_at_ms: number | null }
    expect(row.store_bytes).toBeNull()
    expect(row.store_expires_at_ms).toBeNull()

    // The real directory survives as an orphan and is reclaimed by the sweep —
    // the documented fallback.
    expect(existsSync(join(getCandidateStoreRoot(userDataPath), candidateId))).toBe(true)
    sweepCandidateStoresOnStartup(db, userDataPath, NOW)
    expect(existsSync(join(getCandidateStoreRoot(userDataPath), candidateId))).toBe(false)
  })

  // 10g13 — the same for TTL expiry and supersession, via the sweep.
  it('releases accounting for TTL-expired and superseded stores', () => {
    seedTask(db, 'task1', 'blocked')
    seedTask(db, 'task2', 'awaiting_code_audit')
    const expired = `cand_${'2'.repeat(32)}`
    const superseded = `cand_${'3'.repeat(32)}`
    seedCandidate(db, {
      id: expired,
      taskId: 'task1',
      status: 'current',
      bytes: 100,
      expiresAt: NOW - 1
    })
    seedCandidate(db, {
      id: superseded,
      taskId: 'task2',
      status: 'superseded',
      bytes: 200,
      expiresAt: NOW + CANDIDATE_STORE_RETENTION_TTL_MS
    })
    makeStoreDir(userDataPath, expired)
    makeStoreDir(userDataPath, superseded)

    const result = sweepCandidateStoresOnStartup(db, userDataPath, NOW)

    expect(result.releasedCandidates).toBe(2)
    expect(readChargedBytes(db)).toBe(0)
    expect(existsSync(join(getCandidateStoreRoot(userDataPath), expired))).toBe(false)
    expect(existsSync(join(getCandidateStoreRoot(userDataPath), superseded))).toBe(false)
  })

  // 10g2 — blocked/code_fixes_requested survive within TTL so retry needs no
  // re-audit.
  it('retains stores for blocked and code_fixes_requested tasks within TTL', () => {
    seedTask(db, 'blockedTask', 'blocked')
    seedTask(db, 'fixTask', 'code_fixes_requested')
    const a = `cand_${'4'.repeat(32)}`
    const b = `cand_${'5'.repeat(32)}`
    seedCandidate(db, {
      id: a,
      taskId: 'blockedTask',
      status: 'current',
      bytes: 10,
      expiresAt: NOW + 5000
    })
    seedCandidate(db, {
      id: b,
      taskId: 'fixTask',
      status: 'current',
      bytes: 20,
      expiresAt: NOW + 5000
    })
    makeStoreDir(userDataPath, a)
    makeStoreDir(userDataPath, b)

    sweepCandidateStoresOnStartup(db, userDataPath, NOW)

    expect(existsSync(join(getCandidateStoreRoot(userDataPath), a))).toBe(true)
    expect(existsSync(join(getCandidateStoreRoot(userDataPath), b))).toBe(true)
  })

  // 10g3 — orphan sweep, and non-matching directories left strictly alone.
  it('removes orphan directories and leaves foreign ones untouched', () => {
    const orphan = `cand_${'6'.repeat(32)}`
    makeStoreDir(userDataPath, orphan)
    const foreign = join(getCandidateStoreRoot(userDataPath), 'not-a-candidate')
    mkdirSync(foreign, { recursive: true })

    const result = sweepCandidateStoresOnStartup(db, userDataPath, NOW)

    expect(result.removedDirectories).toBe(1)
    expect(existsSync(join(getCandidateStoreRoot(userDataPath), orphan))).toBe(false)
    expect(existsSync(foreign)).toBe(true)
  })

  // 10g1 — no current-row orphan can grow storage indefinitely.
  it('bounds total durable bytes across repeated rounds on one task', () => {
    seedTask(db, 'task1', 'blocked')
    // Each round supersedes the previous candidate, so a task never accumulates
    // more than one live store.
    for (let round = 0; round < 5; round += 1) {
      db.prepare(
        `UPDATE audited_candidates SET status = 'superseded' WHERE task_id = 'task1'`
      ).run()
      seedCandidate(db, {
        id: `cand_${String(round).repeat(32)}`,
        taskId: 'task1',
        status: 'current',
        bytes: 1000,
        expiresAt: NOW + 5000
      })
    }
    // Only the single `current` row is charged, regardless of history depth.
    expect(readChargedBytes(db)).toBe(1000)
  })

  it('expires held reservations during the startup sweep', () => {
    expect(reserveStoreBytes(db, { candidateId: 'cand_held', bytes: 700 }, NOW).ok).toBe(true)
    expect(readChargedBytes(db)).toBe(700)

    const result = sweepCandidateStoresOnStartup(db, userDataPath, NOW)

    expect(result.expiredReservations).toBe(1)
    expect(readChargedBytes(db)).toBe(0)
  })

  it('recomputes store_bytes from disk when a row disagrees', () => {
    seedTask(db, 'task1', 'awaiting_human_approval')
    const candidateId = `cand_${'7'.repeat(32)}`
    seedCandidate(db, {
      id: candidateId,
      taskId: 'task1',
      status: 'current',
      bytes: 999_999,
      expiresAt: NOW + 5000
    })
    makeStoreDir(userDataPath, candidateId)

    sweepCandidateStoresOnStartup(db, userDataPath, NOW)

    const row = db
      .prepare(`SELECT store_bytes FROM audited_candidates WHERE id = ?`)
      .get(candidateId) as { store_bytes: number | null }
    // The marker file is 1 byte, so the inflated claim is corrected downward.
    expect(row.store_bytes).toBe(1)
  })
})
