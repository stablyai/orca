import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

type DatabaseHarness = {
  db: OrchestrationDb
  dir: string
  path: string
}

const harnesses: DatabaseHarness[] = []

afterEach(() => {
  vi.restoreAllMocks()
  const closed = harnesses.splice(0)
  for (const harness of closed) {
    harness.db.close()
  }
  for (const dir of new Set(closed.map((harness) => harness.dir))) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Task/Dispatch concurrency', () => {
  it('rolls back Dispatch failure when Task requeue fails', () => {
    const { db } = createDatabase()
    const task = db.createTask({ spec: 'atomic retry failure' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    sqliteFor(db).exec(`
      CREATE TRIGGER reject_task_requeue
      BEFORE UPDATE OF status ON tasks
      WHEN OLD.id = '${task.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced task requeue failure');
      END;
    `)

    expect(() => db.failDispatch(dispatch.id, 'must roll back')).toThrow(
      'forced task requeue failure'
    )
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'dispatched',
      failure_count: 0,
      last_failure: null,
      completed_at: null,
      capability_revoked_at: null
    })
  })

  it('does not let stale failure overwrite a completed worker report', () => {
    const first = createDatabase()
    const concurrent = createDatabase(first.path)
    const task = first.db.createTask({ spec: 'worker completion wins' })
    const started = first.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const capability = first.db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processIncarnation: 'worker:1',
      worktreeId: 'repo::worker',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    first.db.markWorkerDispatchReady(started.dispatch.id)
    const sqlite = sqliteFor(first.db)
    const prepare = sqlite.prepare.bind(sqlite)
    let completionWon = false
    vi.spyOn(sqlite, 'prepare').mockImplementation((sql) => {
      if (
        !completionWon &&
        sql.includes('UPDATE dispatch_contexts') &&
        sql.includes('failure_count')
      ) {
        completionWon = true
        expect(
          concurrent.db.settleWorkerReport({
            taskId: task.id,
            dispatchId: started.dispatch.id,
            outcome: 'succeeded',
            result: 'completed concurrently'
          })
        ).toMatchObject({ action: 'settled', duplicate: false })
      }
      return prepare(sql)
    })

    expect(
      first.db.failDispatch(started.dispatch.id, 'stale failure', { workerProcessExited: true })
    ).toMatchObject({
      status: 'completed',
      failure_count: 0
    })
    expect(completionWon).toBe(true)
    expect(first.db.getTask(task.id)).toMatchObject({
      status: 'completed',
      result: 'completed concurrently'
    })
    expect(first.db.getWorkerDispatch(started.dispatch.id)?.state).toBe('succeeded')
    expect(
      first.db.verifyDispatchCapability({
        dispatchId: started.dispatch.id,
        capability,
        paneKey: 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        processIncarnation: 'worker:1'
      })
    ).toMatchObject({ valid: false })
  })

  it('serializes reminted-pane worker authority claims', () => {
    const first = createDatabase()
    const concurrent = createDatabase(first.path)
    const losingTask = first.db.createTask({ spec: 'losing worker' })
    const winningTask = first.db.createTask({ spec: 'winning worker' })
    const loser = first.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: losingTask.id,
      startOptions: {}
    })
    const winner = concurrent.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: winningTask.id,
      startOptions: {}
    })
    const sqlite = sqliteFor(first.db)
    const exec = sqlite.exec.bind(sqlite)
    let winningCapability: string | undefined
    vi.spyOn(sqlite, 'exec').mockImplementation((sql) => {
      if (!winningCapability && sql === 'BEGIN IMMEDIATE') {
        winningCapability = concurrent.db.prepareStartingWorkerAuthority({
          dispatchId: winner.dispatch.id,
          handle: 'term_reminted',
          paneKey: 'tab_new:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          processIncarnation: 'winner:1',
          worktreeId: 'repo::winner',
          effects: [],
          setupState: 'not_applicable',
          terminalOwnership: 'created'
        })
      }
      return exec(sql)
    })

    expect(() =>
      first.db.prepareStartingWorkerAuthority({
        dispatchId: loser.dispatch.id,
        handle: 'term_original',
        paneKey: 'tab_old:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        processIncarnation: 'loser:1',
        worktreeId: 'repo::loser',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: 'created'
      })
    ).toThrow(`already has an active dispatch (${winner.dispatch.id} for task ${winningTask.id})`)
    expect(winningCapability).toBeDefined()
    expect(first.db.getDispatchContextById(loser.dispatch.id)).toMatchObject({
      assignee_handle: null,
      capability_hash: null
    })
    expect(first.db.getWorkerDispatch(loser.dispatch.id)).toMatchObject({
      stage: 'accepted',
      agent_terminal_handle: null
    })
    expect(first.db.getWorkerTerminalResourceByOwner(loser.dispatch.id)).toBeUndefined()
    expect(first.db.getDispatchContextById(winner.dispatch.id)).toMatchObject({
      assignee_handle: 'term_reminted',
      capability_hash: expect.any(String)
    })
    expect(first.db.getWorkerTerminalResourceByOwner(winner.dispatch.id)).toMatchObject({
      terminal_handle: 'term_reminted',
      ownership_state: 'owned'
    })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM dispatch_contexts
           WHERE status IN ('pending', 'dispatched') AND capability_hash IS NOT NULL`
        )
        .get()
    ).toEqual({ count: 1 })
  })
})

function createDatabase(path?: string): DatabaseHarness {
  const dir = path ? harnesses.find((harness) => harness.path === path)?.dir : undefined
  const ownedDir = dir ?? mkdtempSync(join(tmpdir(), 'orca-task-dispatch-races-'))
  const dbPath = path ?? join(ownedDir, 'orchestration.db')
  const harness = { db: new OrchestrationDb(dbPath), dir: ownedDir, path: dbPath }
  harnesses.push(harness)
  return harness
}

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}
