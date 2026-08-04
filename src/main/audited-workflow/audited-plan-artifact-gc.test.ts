// Orphan-artifact reclamation. The property under test is CONSERVATISM: the
// sweep removes only what it can prove is unreferenced, because deleting a
// referenced artifact would destroy the body behind a durable row.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import Database from '../sqlite/sync-database'
import { createAuditedWorkflowTables } from './audited-task-schema'
import {
  reconcilePlanArtifactFiles,
  reconcilePlanArtifactFilesOnStartup
} from './audited-plan-artifact-gc'

let db: Database.Database
let userData: string

const VALID_ID = `plan_${'a'.repeat(32)}`
const OTHER_ID = `plan_${'b'.repeat(32)}`

function plansDir(): string {
  return join(userData, 'audited-workflow', 'plans')
}

function seedArtifactDir(id: string, withTemp = false): string {
  const dir = join(plansDir(), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plan.md'), 'body', 'utf8')
  if (withTemp) {
    writeFileSync(join(dir, '.plan.md.tmp'), 'partial', 'utf8')
  }
  return dir
}

function insertArtifactRow(id: string, status: 'current' | 'superseded'): void {
  db.prepare(
    `INSERT INTO audited_plan_artifacts
       (id, task_id, run_id, round, status, content_sha256, char_count,
        truncated, redaction_count, superseded_by, created_at_ms)
     VALUES (?, 'task_1', ?, 0, ?, 'sha', 4, 0, 0, NULL, 1)`
  ).run(id, `exec_${id}`, status)
}

beforeEach(() => {
  db = new Database(':memory:')
  createAuditedWorkflowTables(db)
  userData = mkdtempSync(join(tmpdir(), 'orca-gc-'))
})

afterEach(() => {
  db.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('reconcilePlanArtifactFiles', () => {
  it('removes a well-formed artifact directory with no row', () => {
    const dir = seedArtifactDir(VALID_ID)
    const result = reconcilePlanArtifactFiles(db, userData)
    expect(result.removedDirectories).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })

  it('RETAINS a directory whose row is current', () => {
    const dir = seedArtifactDir(VALID_ID)
    insertArtifactRow(VALID_ID, 'current')
    reconcilePlanArtifactFiles(db, userData)
    expect(existsSync(dir)).toBe(true)
  })

  // Superseded artifacts are audit history, not garbage.
  it('RETAINS a directory whose row is superseded', () => {
    const dir = seedArtifactDir(VALID_ID)
    insertArtifactRow(VALID_ID, 'superseded')
    reconcilePlanArtifactFiles(db, userData)
    expect(existsSync(dir)).toBe(true)
  })

  it('RETAINS a directory whose name could never be an artifact id', () => {
    const dir = join(plansDir(), 'not-an-artifact')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'important.txt'), 'x', 'utf8')

    const result = reconcilePlanArtifactFiles(db, userData)
    expect(result.removedDirectories).toBe(0)
    expect(existsSync(dir)).toBe(true)
  })

  it('removes a stray temp file beside a referenced artifact', () => {
    const dir = seedArtifactDir(VALID_ID, true)
    insertArtifactRow(VALID_ID, 'current')

    const result = reconcilePlanArtifactFiles(db, userData)
    expect(result.removedTempFiles).toBe(1)
    expect(existsSync(join(dir, '.plan.md.tmp'))).toBe(false)
    // The committed body is untouched.
    expect(existsSync(join(dir, 'plan.md'))).toBe(true)
  })

  it('reclaims only the orphan when both an orphan and a referenced artifact exist', () => {
    const orphan = seedArtifactDir(VALID_ID)
    const referenced = seedArtifactDir(OTHER_ID)
    insertArtifactRow(OTHER_ID, 'current')

    reconcilePlanArtifactFiles(db, userData)

    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(referenced)).toBe(true)
  })

  it('is a no-op when the plans directory does not exist', () => {
    expect(() => reconcilePlanArtifactFiles(db, userData)).not.toThrow()
    expect(reconcilePlanArtifactFiles(db, userData)).toEqual({
      removedDirectories: 0,
      removedTempFiles: 0
    })
  })

  it('is idempotent', () => {
    seedArtifactDir(VALID_ID)
    reconcilePlanArtifactFiles(db, userData)
    expect(reconcilePlanArtifactFiles(db, userData)).toEqual({
      removedDirectories: 0,
      removedTempFiles: 0
    })
  })
})

describe('reconcilePlanArtifactFilesOnStartup', () => {
  it('never throws, so IPC handler registration cannot be aborted', () => {
    const closed = new Database(':memory:')
    closed.close()
    expect(() => reconcilePlanArtifactFilesOnStartup(closed, userData)).not.toThrow()
  })
})
