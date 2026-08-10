import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('Run lineage storage', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  let paneCounter = 0

  function createRun(d: OrchestrationDb, objective: string, parentRunId?: string): string {
    paneCounter += 1
    const pane = String(paneCounter).padStart(12, '0')
    return d.createRun({
      objective,
      coordinatorHandle: `term_${objective}`,
      coordinatorPaneKey: `tab_${objective}:aaaaaaaa-aaaa-4aaa-8aaa-${pane}`,
      parentRunId
    }).id
  }

  it('records the parent Run and leaves top-level Runs unparented', () => {
    const d = createDb()
    const general = createRun(d, 'general')
    const captain = createRun(d, 'captain', general)

    expect(d.getRun(general)?.parent_run_id).toBeNull()
    expect(d.getRun(captain)?.parent_run_id).toBe(general)
  })

  it('lists the child Runs of a parent and nothing else', () => {
    const d = createDb()
    const general = createRun(d, 'general')
    const alpha = createRun(d, 'alpha', general)
    const bravo = createRun(d, 'bravo', general)
    createRun(d, 'unrelated')

    expect([...d.listChildRunIds(general)].sort()).toEqual([alpha, bravo].sort())
    expect(d.listChildRunIds(alpha)).toEqual([])
  })

  it('filters run-list by parent, with and without pagination', () => {
    const d = createDb()
    const general = createRun(d, 'general')
    const alpha = createRun(d, 'alpha', general)
    const bravo = createRun(d, 'bravo', general)
    createRun(d, 'unrelated')

    const all = d.listRuns({ parentRunId: general })
    expect(all.runs.map((run) => run.id).sort()).toEqual([alpha, bravo].sort())
    expect(all.nextCursor).toBeNull()

    const firstPage = d.listRuns({ parentRunId: general, limit: 1 })
    expect(firstPage.runs).toHaveLength(1)
    expect(firstPage.nextCursor).not.toBeNull()

    const secondPage = d.listRuns({
      parentRunId: general,
      limit: 1,
      cursor: firstPage.nextCursor as string
    })
    expect(secondPage.runs).toHaveLength(1)
    expect([...firstPage.runs, ...secondPage.runs].map((run) => run.id).sort()).toEqual(
      [alpha, bravo].sort()
    )
  })

  it('adds the lineage column to a database written before it existed', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-run-lineage-'))
    const dbPath = join(tempDir, 'orchestration.db')

    const seeded = new OrchestrationDb(dbPath)
    const runId = createRun(seeded, 'pre-lineage')
    seeded.close()

    // Why: reproduce a v25 database exactly — the column and its index did not exist yet.
    const raw = new Database(dbPath)
    raw.exec('DROP INDEX IF EXISTS idx_runs_parent')
    raw.exec('ALTER TABLE runs DROP COLUMN parent_run_id')
    raw.pragma('user_version = 25')
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(db.getRun(runId)?.objective).toBe('pre-lineage')
    expect(db.getRun(runId)?.parent_run_id).toBeNull()
    expect(db.listChildRunIds(runId)).toEqual([])
  })
})
