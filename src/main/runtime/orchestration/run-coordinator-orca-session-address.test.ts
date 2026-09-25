import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatOrcaSessionAddress,
  parseOrcaSessionAddress
} from '../../../shared/orca-session-address'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { OrchestrationDb } from './db'
import { backfillStructuredWorkerOrcaSessionIds } from './db/schema/structured-worker-orca-session-backfill'

const CHAT_SESSION_ID = '3a5c7e9b-1d4f-4a6c-8b0e-2f4a6c8e0b14'
const CHAT_ADDRESS = formatOrcaSessionAddress(CHAT_SESSION_ID)
const WORKER_SESSION_ID = '4b6d8f0c-2e5a-4b7d-9c1f-3a5b7d9f1c25'
const WORKER_ADDRESS = formatOrcaSessionAddress(WORKER_SESSION_ID)
const PTY_PANE = 'tab_pty:66666666-6666-4666-8666-666666666666'

function addressesFor(db: OrchestrationDb, runId: string): string[] {
  return db.db
    .prepare('SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?')
    .all(runId)
    .map((row) => String(row.terminal_handle))
    .sort()
}

function tempDbPath(tempRoots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-run-coordinator-orca-session-'))
  tempRoots.push(root)
  return join(root, 'orchestration.db')
}

/** Drops the Run's remembered addresses and reopens, so only the on-open refill can write them back. */
function refillAfterReopen(db: OrchestrationDb, path: string, runId: string): OrchestrationDb {
  db.db.prepare('DELETE FROM run_coordinator_handles WHERE run_id = ?').run(runId)
  db.close()
  return new OrchestrationDb(path)
}

/** A handle-less coordinator row; no writer records one until the caller resolver lands. */
function insertSessionCoordinatedRun(db: OrchestrationDb, runId: string): void {
  db.db
    .prepare(
      `INSERT INTO runs (
         id, objective, coordinator_orca_session_id, coordinator_orca_session_id_generation,
         consumer_generation, legacy
       ) VALUES (?, 'coordinated by a structured session', ?, 1, 1, 0)`
    )
    .run(runId, CHAT_SESSION_ID)
}

describe('Run coordinator Orca session address', () => {
  let db: OrchestrationDb | undefined
  const tempRoots: string[] = []

  afterEach(() => {
    db?.close()
    db = undefined
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('remembers a handle-less session coordinator by the address derived from its bare id', () => {
    db = new OrchestrationDb(':memory:')
    insertSessionCoordinatedRun(db, 'run_session')

    // The column holds the bare id; only the remembered address carries the session: prefix.
    expect(db.getRunRaw('run_session')?.coordinator_orca_session_id).toBe(CHAT_SESSION_ID)
    expect(addressesFor(db, 'run_session')).toEqual([CHAT_ADDRESS])
    expect(parseOrcaSessionAddress(addressesFor(db, 'run_session')[0])).toBe(CHAT_SESSION_ID)
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_ADDRESS)).toEqual(['run_session'])
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_SESSION_ID)).toEqual([])
    // The existing routing trigger matches the address by string equality, unchanged.
    const reply = db.insertMessage({
      runId: 'run_session',
      from: 'term_worker',
      to: CHAT_ADDRESS,
      subject: 'done',
      type: 'worker_done'
    })
    expect(db.getMessageById(reply.id)?.to_handle).toBe('run:run_session')
  })

  it('remembers an Orca session id bound by update, and again on reopen when the cache row is gone', () => {
    const path = tempDbPath(tempRoots)
    db = new OrchestrationDb(path)
    db.db
      .prepare(
        `INSERT INTO runs (id, objective, consumer_generation, legacy)
         VALUES ('run_unbound', 'bound later', 1, 0)`
      )
      .run()
    db.db
      .prepare(
        `UPDATE runs SET coordinator_orca_session_id = ?,
           coordinator_orca_session_id_generation = consumer_generation
         WHERE id = ?`
      )
      .run(CHAT_SESSION_ID, 'run_unbound')
    expect(addressesFor(db, 'run_unbound')).toEqual([CHAT_ADDRESS])

    db = refillAfterReopen(db, path, 'run_unbound')
    expect(addressesFor(db, 'run_unbound')).toEqual([CHAT_ADDRESS])
  })

  it('remembers a PTY coordinator written by insert, update and refill by exactly its handle', () => {
    const path = tempDbPath(tempRoots)
    db = new OrchestrationDb(path)
    db.db
      .prepare(
        `INSERT INTO runs (id, objective, coordinator_handle, consumer_generation, legacy)
         VALUES ('run_pty', 'pty', 'term_first', 1, 0)`
      )
      .run()
    expect(addressesFor(db, 'run_pty')).toEqual(['term_first'])
    db.db
      .prepare(
        `UPDATE runs SET coordinator_handle = 'term_second',
           consumer_generation = consumer_generation + 1 WHERE id = 'run_pty'`
      )
      .run()
    expect(addressesFor(db, 'run_pty')).toEqual(['term_first', 'term_second'])

    db = refillAfterReopen(db, path, 'run_pty')
    expect(addressesFor(db, 'run_pty')).toEqual(['term_second'])
  })

  it('remembers a structured-worker coordinator by its handle and its session address', () => {
    const path = tempDbPath(tempRoots)
    db = new OrchestrationDb(path)
    const handle = mintStructuredWorkerHandle()
    db.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_orca_session_id,
           coordinator_orca_session_id_generation, consumer_generation, legacy
         ) VALUES ('run_inserted', 'structured worker', ?, ?, 1, 1, 0)`
      )
      .run(handle, WORKER_SESSION_ID)
    expect(addressesFor(db, 'run_inserted')).toEqual([WORKER_ADDRESS, handle].sort())

    db.db
      .prepare(
        `INSERT INTO runs (id, objective, coordinator_handle, consumer_generation, legacy)
         VALUES ('run_updated', 'id recorded later', ?, 1, 0)`
      )
      .run(handle)
    db.db
      .prepare(
        `UPDATE runs SET coordinator_orca_session_id = ?,
           coordinator_orca_session_id_generation = consumer_generation
         WHERE id = 'run_updated'`
      )
      .run(WORKER_SESSION_ID)
    expect(addressesFor(db, 'run_updated')).toEqual([WORKER_ADDRESS, handle].sort())

    db = refillAfterReopen(db, path, 'run_updated')
    expect(addressesFor(db, 'run_updated')).toEqual([WORKER_ADDRESS, handle].sort())
    expect(db.getRunMailboxOwnerIdsForHandle(WORKER_ADDRESS)).toEqual(
      db.getRunMailboxOwnerIdsForHandle(handle)
    )
  })

  it('adds no session address for an Orca session id at a stale generation', () => {
    const path = tempDbPath(tempRoots)
    db = new OrchestrationDb(path)
    db.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_orca_session_id,
           coordinator_orca_session_id_generation, consumer_generation, legacy
         ) VALUES ('run_stale_insert', 'stale id', 'term_stale', ?, 1, 2, 0)`
      )
      .run(WORKER_SESSION_ID)
    expect(addressesFor(db, 'run_stale_insert')).toEqual(['term_stale'])

    db.db
      .prepare(
        `INSERT INTO runs (id, objective, consumer_generation, legacy)
         VALUES ('run_stale_update', 'written stale', 2, 0)`
      )
      .run()
    db.db
      .prepare(
        `UPDATE runs SET coordinator_orca_session_id = ?, coordinator_orca_session_id_generation = 1
         WHERE id = 'run_stale_update'`
      )
      .run(WORKER_SESSION_ID)
    expect(addressesFor(db, 'run_stale_update')).toEqual([])

    db = refillAfterReopen(db, path, 'run_stale_insert')
    expect(addressesFor(db, 'run_stale_insert')).toEqual(['term_stale'])
    expect(db.getRunMailboxOwnerIdsForHandle(WORKER_ADDRESS)).toEqual([])
  })

  it('keeps PTY coordinators remembered by handle alone', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'pty',
      coordinatorHandle: 'term_first',
      coordinatorPaneKey: PTY_PANE
    })
    db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_second',
      coordinatorPaneKey: 'tab_second:77777777-7777-4777-8777-777777777777'
    })

    expect(db.getRunRaw(run.id)?.coordinator_orca_session_id).toBeNull()
    expect(addressesFor(db, run.id)).toEqual(['term_first', 'term_second'])
  })

  it("never leaves a replaced structured coordinator's Orca session id on the Run", () => {
    db = new OrchestrationDb(':memory:')
    const handle = mintStructuredWorkerHandle()
    const pane = mintStructuredWorkerPaneKey(WORKER_SESSION_ID)
    const ownTask = db.createTask({ runId: 'run_legacy_local', spec: 'structured worker' })
    db.createDispatchContext({
      taskId: ownTask.id,
      assigneeHandle: handle,
      assigneePaneKey: pane,
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_SESSION_ID),
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const first = db.createRun({
      objective: 'first',
      coordinatorHandle: handle,
      coordinatorPaneKey: pane
    })
    backfillStructuredWorkerOrcaSessionIds(db.db)
    expect(db.getRunRaw(first.id)?.coordinator_orca_session_id).toBe(WORKER_SESSION_ID)

    // A second Run from the same pane unbinds the first.
    const second = db.createRun({
      objective: 'second',
      coordinatorHandle: handle,
      coordinatorPaneKey: pane
    })
    expect(db.getRunRaw(first.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_orca_session_id: null
    })

    backfillStructuredWorkerOrcaSessionIds(db.db)
    expect(db.getRunRaw(second.id)?.coordinator_orca_session_id).toBe(WORKER_SESSION_ID)
    db.bindRun({ runId: second.id, coordinatorHandle: 'term_taker', coordinatorPaneKey: PTY_PANE })
    expect(db.getRunRaw(second.id)).toMatchObject({
      coordinator_handle: 'term_taker',
      coordinator_orca_session_id: null
    })
    // A remembered address is never forgotten, so the worker's session address reaches exactly the
    // Runs its handle does.
    expect(db.getRunMailboxOwnerIdsForHandle(WORKER_ADDRESS)).toEqual([first.id, second.id].sort())
    expect(db.getRunMailboxOwnerIdsForHandle(handle)).toEqual([first.id, second.id].sort())
  })
})
