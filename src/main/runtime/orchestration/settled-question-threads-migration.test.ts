import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

/** v38 closes question threads left pending on Dispatches that settled through the task path. */
describe('OrchestrationDb v37 to v38 migration', () => {
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

  /** A v37 database with one pending question on a settled Dispatch and one on an active one. */
  function createV37Database(): { path: string; settled: string; active: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-v38-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const seed = new OrchestrationDb(dbPath)
    const run = seed.createRun({
      objective: 'pre-v38 run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    const ask = (dispatchId: string) =>
      seed.createQuestion({
        runId: run.id,
        dispatchId,
        askerHandle: 'term_worker',
        question: 'still pending?'
      }).question.message_id
    const settledTask = seed.createTask({ spec: 'settled before v38', runId: run.id })
    const settledDispatch = createRootDispatch(seed, settledTask.id, 'term_worker')
    const settled = ask(settledDispatch.id)
    const activeTask = seed.createTask({ spec: 'still running', runId: run.id })
    const active = ask(createRootDispatch(seed, activeTask.id, 'term_worker_2').id)
    seed.close()

    // Why: pre-v38 settlement left the thread pending; recreate that on-disk shape directly.
    const raw = new Database(dbPath)
    raw
      .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
      .run(settledDispatch.id)
    raw.prepare("UPDATE question_threads SET status = 'pending', closed_at = NULL").run()
    raw.pragma('user_version = 37')
    raw.close()
    return { path: dbPath, settled, active }
  }

  it('closes pending questions on settled dispatches and keeps active ones pending', () => {
    const v37 = createV37Database()
    db = new OrchestrationDb(v37.path)

    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getQuestion(v37.settled)?.status).toBe('closed')
    expect(db.getQuestion(v37.active)?.status).toBe('pending')
  })
})
