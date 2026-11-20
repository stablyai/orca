import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatOrcaSessionAddress,
  type OrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../terminal-authority/structured-sessions/structured-worker-identity'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { coordinatorAliasRowSql, runOwnsDirectMessageSql } from './run-coordinator-mail-routing'
import {
  coordinatorSessionAliasBackfillSql,
  pruneStaleChatCoordinatorAliases
} from './run-coordinator-session-alias'

const CHAT_X_ID = testOrcaSessionId('1b6f0c3a-7d2e-4a91-8c55-2e9d4b7a0f13')
const CHAT_X = formatOrcaSessionAddress(CHAT_X_ID)
const CHAT_Y_ID = testOrcaSessionId('6d2a9e41-0c7b-4f38-9a15-b3e8c1d57f20')
const CHAT_Y = formatOrcaSessionAddress(CHAT_Y_ID)
// Reporter's `orca agent list --json` shape: provider prefix and underscores, not a hyphenated UUID.
const LEGACY_CHAT_ID = testOrcaSessionId('claude_5688af50_12a0_4b0b_9a4a_098d87fe1e68')
const LEGACY_CHAT = formatOrcaSessionAddress(LEGACY_CHAT_ID)
const PTY_PANE = 'tab_pty:11111111-1111-4111-8111-111111111111'

function handles(db: OrchestrationDb, runId: string): string[] {
  return db.db
    .prepare('SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?')
    .all(runId)
    .map((row) => String(row.terminal_handle))
}

/** Pre-upgrade 3-column aliases after takeover. Every row shares one second, so timestamp cannot tell them apart. */
function installThreeColumnAliases(
  path: string,
  takeovers: readonly (readonly [string, OrcaSessionId])[],
  rows: readonly (readonly [string, string])[]
): void {
  const raw = new Database(path)
  const takeOver = raw.prepare(
    `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
       coordinator_orca_session_id = ?, coordinator_orca_session_id_generation = consumer_generation
     WHERE id = ?`
  )
  for (const [runId, sessionId] of takeovers) {
    takeOver.run(sessionId, runId)
  }
  raw.exec(`
    DROP TABLE run_coordinator_handles;
    CREATE TABLE run_coordinator_handles (
      run_id TEXT NOT NULL,
      terminal_handle TEXT NOT NULL,
      first_bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, terminal_handle)
    );
  `)
  const insert = raw.prepare(
    'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
  )
  for (const [runId, handle] of rows) {
    insert.run(runId, handle, '2026-11-21 00:00:00')
  }
  raw.close()
}

describe('stale chat coordinator aliases', () => {
  let db: OrchestrationDb | undefined
  const tempRoots: string[] = []

  afterEach(() => {
    db?.close()
    db = undefined
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createChatRun(orcaSessionId: OrcaSessionId) {
    return db!.createRun({
      objective: 'chat',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: orcaSessionId
    })
  }

  function takeOverRememberedWorker(
    path: string,
    runId: string,
    workerHandle: string,
    address: string
  ) {
    installThreeColumnAliases(
      path,
      [[runId, CHAT_X_ID]],
      [
        [runId, workerHandle],
        [runId, address],
        [runId, CHAT_Y]
      ]
    )
  }

  function expectWorkerAliasKept(runId: string, address: string) {
    expect(handles(db!, runId)).toContain(address)
    expect(handles(db!, runId)).not.toContain(CHAT_Y)
    expect(db!.getRunMailboxOwnerIdsForHandle(address)).toEqual([runId])
    expect(db!.getRunMailboxOwnerIdsForHandle(CHAT_Y)).toEqual([])
  }

  it('ignores a pre-upgrade alias, and opening the database deletes it', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-stale-alias-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    db = new OrchestrationDb(path)
    const run = createChatRun(CHAT_X_ID)
    db.db
      .prepare(
        `INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at)
         VALUES (?, ?, datetime('now', '-1 day'))`
      )
      .run(run.id, CHAT_Y)
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_Y)).toEqual([])
    const pending = db.insertMessage({
      from: 'term_sender',
      to: CHAT_Y,
      subject: 'for Y',
      body: '',
      runId: run.id
    })
    expect(db.getMessageById(pending.id)?.to_handle).toBe(CHAT_Y)

    pruneStaleChatCoordinatorAliases(db.db)
    expect(handles(db, run.id)).not.toContain(CHAT_Y)
    expect(handles(db, run.id)).toContain(CHAT_X)

    db.close()
    db = new OrchestrationDb(path)
    db.db
      .prepare(
        `INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at)
         VALUES (?, ?, datetime('now', '-1 day'))`
      )
      .run(run.id, CHAT_Y)
    db.close()
    db = new OrchestrationDb(path)
    expect(handles(db, run.id)).not.toContain(CHAT_Y)
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_X)).toEqual([run.id])
  })

  it('treats a legacy agent_uuid chat id as a chat alias, not a structured worker', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(LEGACY_CHAT_ID)
    expect(db.getRunMailboxOwnerIdsForHandle(LEGACY_CHAT)).toEqual([run.id])
    db.db
      .prepare(
        `UPDATE runs SET coordinator_handle = 'term_taker', coordinator_pane_key = ?,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(PTY_PANE, run.id)
    expect(db.getRunMailboxOwnerIdsForHandle(LEGACY_CHAT)).toEqual([])
    expect(handles(db, run.id)).not.toContain(LEGACY_CHAT)
    const next = createChatRun(LEGACY_CHAT_ID)
    expect(
      db.getCurrentRunForCoordinator({
        terminalHandle: null,
        paneKey: null,
        orcaSessionId: LEGACY_CHAT_ID
      })?.id
    ).toBe(next.id)
    expect(db.getRunRaw(run.id)?.coordinator_handle).toBe('term_taker')
  })

  it('distinguishes pre-binding and post-binding direct mail on the same second across every routing path', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X_ID)
    const preBind = db.insertMessage({
      from: 'term_sender',
      to: CHAT_Y,
      subject: 'before bind',
      body: '',
      runId: run.id
    })
    db.bindRun({
      runId: run.id,
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: CHAT_Y_ID
    })
    const postBind = db.insertMessage({
      from: 'term_sender',
      to: 'term_late',
      subject: 'after bind stray',
      body: '',
      runId: run.id
    })
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(CHAT_Y, postBind.id)

    expect(
      db.getUnreadMessages(CHAT_Y, undefined, { excludeRunOwnedDirect: true }).map((m) => m.id)
    ).toEqual([preBind.id])
    expect(db.routeUnreadDirectMessagesToRunMailbox(run.id, CHAT_Y)).toMatchObject({
      routedCount: 1
    })
    expect(db.getMessageById(preBind.id)?.to_handle).toBe(CHAT_Y)
    expect(db.getMessageById(postBind.id)?.to_handle).toBe(`run:${run.id}`)

    // Even if a post-bind row lands direct again, foreign routing moves only the post-bind row.
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(CHAT_Y, postBind.id)
    expect(db.routeForeignDirectMessagesToOwnedMailboxes(CHAT_Y)).toMatchObject({
      routedCount: 1
    })
    expect(db.getMessageById(preBind.id)?.to_handle).toBe(CHAT_Y)
    expect(db.getMessageById(postBind.id)?.to_handle).toBe(`run:${run.id}`)
  })

  it('tracks structured-worker aliases without timestamp equality, and upgrades pre-upgrade tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-upgrade-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()

    db = new OrchestrationDb(path)
    const run = db.createRun({
      objective: 'worker',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: mintStructuredWorkerPaneKey(workerSession),
      coordinatorOrcaSessionId: workerSession
    })
    // Simulate a pre-upgrade 3-column table containing a same-second stale chat row alongside the worker.
    db.close()
    db = undefined
    const raw = new Database(path)
    raw.exec(`
      DROP TABLE run_coordinator_handles;
      CREATE TABLE run_coordinator_handles (
        run_id TEXT NOT NULL,
        terminal_handle TEXT NOT NULL,
        first_bound_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, terminal_handle)
      );
    `)
    const sameSecond = '2026-11-21 00:00:00'
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, workerHandle, sameSecond)
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, workerAddress, '2026-11-21 00:00:01')
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, CHAT_Y, sameSecond)
    raw.close()

    db = new OrchestrationDb(path)
    // Stale chat row is pruned despite sharing first_bound_at with workerHandle.
    expect(handles(db, run.id)).not.toContain(CHAT_Y)
    // Worker session alias stays remembered after takeover even with skewed timestamps and no Dispatches.
    db.bindRun({
      runId: run.id,
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: CHAT_X_ID
    })
    expect(db.getRunMailboxOwnerIdsForHandle(workerAddress)).toEqual([run.id])
  })

  it('stamps a worker session from its creation Dispatch when takeover happened before upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-takeover-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('c2a4e6b8-1d3f-4a50-9b70-6e8c0a2d4f16')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()

    db = new OrchestrationDb(path)
    const origin = db.createRun({
      objective: 'origin',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: PTY_PANE
    })
    // The Dispatch that created the worker, on the Run it works, not the Run it later coordinates.
    db.createDispatchContext({
      taskId: db.createTask({ runId: origin.id, spec: 'work' }).id,
      assigneeHandle: workerHandle,
      assigneePaneKey: mintStructuredWorkerPaneKey(workerSession),
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      creator: { kind: 'terminal', handle: 'term_coord' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const run = db.createRun({
      objective: 'worker coordinates',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: mintStructuredWorkerPaneKey(workerSession),
      coordinatorOrcaSessionId: workerSession
    })
    db.close()
    db = undefined
    const raw = new Database(path)
    // Takeover on the pre-upgrade schema, before the new column exists.
    raw
      .prepare(
        `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
           coordinator_orca_session_id = ?, coordinator_orca_session_id_generation = consumer_generation
         WHERE id = ?`
      )
      .run(CHAT_X_ID, run.id)
    raw.exec(`
      DROP TABLE run_coordinator_handles;
      CREATE TABLE run_coordinator_handles (
        run_id TEXT NOT NULL,
        terminal_handle TEXT NOT NULL,
        first_bound_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, terminal_handle)
      );
    `)
    const sameSecond = '2026-11-21 00:00:00'
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, workerHandle, sameSecond)
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, workerAddress, sameSecond)
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, CHAT_Y, sameSecond)
    raw.close()

    db = new OrchestrationDb(path)
    expect(handles(db, run.id)).not.toContain(CHAT_Y)
    expect(db.getRunMailboxOwnerIdsForHandle(workerAddress)).toEqual([run.id])

    // Settled-run retirement deletes that Dispatch later. The stamp has to outlive it.
    db.db.prepare('DELETE FROM dispatch_contexts').run()
    db.close()
    db = new OrchestrationDb(path)
    expect(handles(db, run.id)).toContain(workerAddress)
    expect(db.getRunMailboxOwnerIdsForHandle(workerAddress)).toEqual([run.id])
  })

  it('stamps a former worker alias from Run messages or another coordinated Run even when its creation Dispatch retired pre-upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-retired-preupgrade-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('d3b5f7a9-2e4c-4b61-8c82-1f9e0b3c5d27')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()
    const workerPaneKey = mintStructuredWorkerPaneKey(workerSession)

    db = new OrchestrationDb(path)
    const run = db.createRun({
      objective: 'worker coordinated then retired origin pre-upgrade',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: workerPaneKey,
      coordinatorOrcaSessionId: workerSession
    })
    db.insertMessage({
      from: workerHandle,
      senderPaneKey: workerPaneKey,
      to: 'term_peer',
      subject: 'from worker before takeover',
      body: '',
      runId: run.id
    })
    db.close()
    db = undefined

    const raw = new Database(path)
    // Takeover happened and origin Run A's dispatch/resource rows were already retired before upgrade.
    raw
      .prepare(
        `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
           coordinator_orca_session_id = ?, coordinator_orca_session_id_generation = consumer_generation
         WHERE id = ?`
      )
      .run(CHAT_X_ID, run.id)
    raw.exec(`
      DROP TABLE run_coordinator_handles;
      CREATE TABLE run_coordinator_handles (
        run_id TEXT NOT NULL,
        terminal_handle TEXT NOT NULL,
        first_bound_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, terminal_handle)
      );
    `)
    const sameSecond = '2026-11-21 00:00:00'
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, workerHandle, sameSecond)
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, workerAddress, sameSecond)
    raw
      .prepare(
        'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
      )
      .run(run.id, CHAT_Y, sameSecond)
    raw.close()

    db = new OrchestrationDb(path)
    expect(handles(db, run.id)).not.toContain(CHAT_Y)
    expect(handles(db, run.id)).toContain(workerAddress)
    expect(db.getRunMailboxOwnerIdsForHandle(workerAddress)).toEqual([run.id])
  })

  it('stamps a former worker alias from another active Run it coordinates when its origin Dispatch retired pre-upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-cross-run-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('e4c6a8b0-3f5d-4c72-9d93-2a0f1c4d6e38')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()
    const workerPaneKey = mintStructuredWorkerPaneKey(workerSession)

    db = new OrchestrationDb(path)
    const takenOverRun = db.createRun({
      objective: 'run lost before upgrade with no messages or dispatches',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: workerPaneKey,
      coordinatorOrcaSessionId: workerSession
    })
    const activeOtherRun = db.createRun({
      objective: 'other run still coordinated by the same worker',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: workerPaneKey,
      coordinatorOrcaSessionId: workerSession
    })
    db.close()
    db = undefined

    const raw = new Database(path)
    raw
      .prepare(
        `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
           coordinator_orca_session_id = ?, coordinator_orca_session_id_generation = consumer_generation
         WHERE id = ?`
      )
      .run(CHAT_X_ID, takenOverRun.id)
    raw.exec(`
      DROP TABLE run_coordinator_handles;
      CREATE TABLE run_coordinator_handles (
        run_id TEXT NOT NULL,
        terminal_handle TEXT NOT NULL,
        first_bound_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, terminal_handle)
      );
    `)
    const sameSecond = '2026-11-21 00:00:00'
    for (const [runId, handle] of [
      [takenOverRun.id, workerHandle],
      [takenOverRun.id, workerAddress],
      [takenOverRun.id, CHAT_Y],
      [activeOtherRun.id, workerHandle],
      [activeOtherRun.id, workerAddress]
    ] as const) {
      raw
        .prepare(
          'INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at) VALUES (?, ?, ?)'
        )
        .run(runId, handle, sameSecond)
    }
    raw.close()

    db = new OrchestrationDb(path)
    expect(handles(db, takenOverRun.id)).not.toContain(CHAT_Y)
    expect(handles(db, takenOverRun.id)).toContain(workerAddress)
    expect(db.getRunMailboxOwnerIdsForHandle(workerAddress).sort()).toEqual(
      [takenOverRun.id, activeOtherRun.id].sort()
    )
  })

  it('stamps Run A from a worker message that survives only on Run B after both coordinators changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-cross-message-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('f5d7b9c1-4a6e-4d83-8e04-3b1a2d5e7f49')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()
    const workerPaneKey = mintStructuredWorkerPaneKey(workerSession)

    db = new OrchestrationDb(path)
    const runA = db.createRun({
      objective: 'run A lost before upgrade',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: workerPaneKey,
      coordinatorOrcaSessionId: workerSession
    })
    const runB = db.createRun({
      objective: 'run B lost before upgrade, message survives here',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: workerPaneKey,
      coordinatorOrcaSessionId: workerSession
    })
    db.insertMessage({
      from: workerHandle,
      senderPaneKey: workerPaneKey,
      to: 'term_peer',
      subject: 'only proof, on B',
      body: '',
      runId: runB.id
    })
    db.close()
    db = undefined

    installThreeColumnAliases(
      path,
      [
        [runA.id, CHAT_X_ID],
        [runB.id, LEGACY_CHAT_ID]
      ],
      [
        [runA.id, workerHandle],
        [runA.id, workerAddress],
        [runA.id, CHAT_Y],
        [runB.id, workerHandle],
        [runB.id, workerAddress]
      ]
    )

    db = new OrchestrationDb(path)
    expect(handles(db, runA.id)).toContain(workerAddress)
    expect(handles(db, runA.id)).not.toContain(CHAT_Y)
    expect(handles(db, runB.id)).toContain(workerAddress)
    expect(db.getRunMailboxOwnerIdsForHandle(workerAddress).sort()).toEqual(
      [runA.id, runB.id].sort()
    )
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_Y)).toEqual([])
  })

  it('keeps a worker alias when the only surviving proof is a heartbeat on another Run', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-heartbeat-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('b7f9d1e3-6c80-4fa5-a126-5d3c4f709b61')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()
    const workerPaneKey = mintStructuredWorkerPaneKey(workerSession)

    db = new OrchestrationDb(path)
    const takenOver = db.createRun({
      objective: 'taken over before upgrade',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: workerPaneKey,
      coordinatorOrcaSessionId: workerSession
    })
    const other = db.createRun({
      objective: 'holds the only heartbeat',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: LEGACY_CHAT_ID
    })
    db.insertMessage({
      from: workerHandle,
      senderPaneKey: workerPaneKey,
      to: 'term_peer',
      subject: 'still alive',
      body: '',
      type: 'heartbeat',
      runId: other.id
    })
    expect(
      db.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE type <> 'heartbeat'`).get()
    ).toEqual({ n: 0 })
    db.close()
    db = undefined

    takeOverRememberedWorker(path, takenOver.id, workerHandle, workerAddress)
    db = new OrchestrationDb(path)
    expectWorkerAliasKept(takenOver.id, workerAddress)
  })

  it('keeps a worker alias when a task records its handle and process incarnation', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-task-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('c8a0e2f4-7d91-4ab6-b237-6e4d5081ac72')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()

    db = new OrchestrationDb(path)
    const run = db.createRun({
      objective: 'task is the only proof',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: mintStructuredWorkerPaneKey(workerSession),
      coordinatorOrcaSessionId: workerSession
    })
    db.createTask({
      runId: run.id,
      spec: 'work',
      createdByTerminalHandle: workerHandle,
      createdByProcessIncarnation: structuredWorkerProcessIncarnation(workerSession)
    })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()).toEqual({ n: 0 })
    db.close()
    db = undefined

    takeOverRememberedWorker(path, run.id, workerHandle, workerAddress)
    db = new OrchestrationDb(path)
    expectWorkerAliasKept(run.id, workerAddress)
  })

  it('keeps a worker alias when a removed dispatch pairs its handle and session', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-removed-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('d9b1f305-8ea2-4bc7-8348-7f5e6192bd83')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()
    const workerPaneKey = mintStructuredWorkerPaneKey(workerSession)

    db = new OrchestrationDb(path)
    const run = db.createRun({
      objective: 'removed dispatch is the only proof',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: workerPaneKey,
      coordinatorOrcaSessionId: workerSession
    })
    const task = db.createTask({ runId: run.id, spec: 'work' })
    db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: workerHandle,
      assigneePaneKey: workerPaneKey,
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      creator: { kind: 'terminal', handle: 'term_coord' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.close()
    db = undefined

    const raw = new Database(path)
    raw.exec(`
      DELETE FROM dispatch_contexts;
      DELETE FROM messages;
      DELETE FROM worker_terminal_resources;
      DELETE FROM worker_dispatches;
    `)
    const removed = raw
      .prepare(
        `SELECT record FROM removed_orchestration_work WHERE kind = 'dispatch' ORDER BY seq DESC LIMIT 1`
      )
      .get() as { record: string }
    const record: unknown = JSON.parse(removed.record)
    expect(record).toMatchObject({
      assigneeHandle: workerHandle,
      assigneeOrcaSessionId: workerSession
    })
    expect(raw.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()).toEqual({ n: 0 })
    expect(
      raw
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE created_by_process_incarnation IS NOT NULL')
        .get()
    ).toEqual({ n: 0 })
    raw.close()

    takeOverRememberedWorker(path, run.id, workerHandle, workerAddress)
    db = new OrchestrationDb(path)
    expectWorkerAliasKept(run.id, workerAddress)
  })

  it('prunes a former worker session when takeover left no surviving proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-alias-no-proof-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const workerSession = testOrcaSessionId('a6e8c0d2-5b7f-4e94-9f15-4c2b3e6f8a50')
    const workerAddress = formatOrcaSessionAddress(workerSession)
    const workerHandle = mintStructuredWorkerHandle()
    const workerPaneKey = mintStructuredWorkerPaneKey(workerSession)

    db = new OrchestrationDb(path)
    const run = db.createRun({
      objective: 'worker coordinated, then takeover, with nothing left to prove the session',
      coordinatorHandle: workerHandle,
      coordinatorPaneKey: workerPaneKey,
      coordinatorOrcaSessionId: workerSession
    })
    const proofCounts = db.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM dispatch_contexts) AS dispatches,
           (SELECT COUNT(*) FROM worker_terminal_resources) AS resources,
           (SELECT COUNT(*) FROM worker_dispatches) AS worker_dispatches,
           (SELECT COUNT(*) FROM tasks) AS tasks,
           (SELECT COUNT(*) FROM removed_orchestration_work) AS removed_work`
      )
      .get() as Record<string, number>
    expect(proofCounts).toEqual({
      messages: 0,
      dispatches: 0,
      resources: 0,
      worker_dispatches: 0,
      tasks: 0,
      removed_work: 0
    })
    db.close()
    db = undefined

    // Same second as the worker handle and as an unrelated chat. The 3-column table cannot tell them apart.
    installThreeColumnAliases(
      path,
      [[run.id, CHAT_X_ID]],
      [
        [run.id, workerHandle],
        [run.id, workerAddress],
        [run.id, CHAT_Y]
      ]
    )

    db = new OrchestrationDb(path)
    expect(handles(db, run.id)).not.toContain(workerAddress)
    expect(handles(db, run.id)).not.toContain(CHAT_Y)
    expect(handles(db, run.id)).toContain(workerHandle)
    expect(db.getRunMailboxOwnerIdsForHandle(workerAddress)).toEqual([])
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_Y)).toEqual([])
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_X)).toEqual([run.id])
  })

  it('probes dispatch_contexts and worker_terminal_resources by index with no table scan', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X_ID)
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const workerSession = testOrcaSessionId('9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48')
    db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: mintStructuredWorkerHandle(),
      assigneePaneKey: mintStructuredWorkerPaneKey(workerSession),
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      creator: { kind: 'session', orcaSessionId: CHAT_X_ID },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.db.exec('ANALYZE')

    const ownerPlan = db.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT coordinator.run_id
         FROM run_coordinator_handles AS coordinator
         JOIN runs ON runs.id = coordinator.run_id AND runs.legacy = 0
         WHERE coordinator.terminal_handle = ? AND ${coordinatorAliasRowSql('coordinator')}`
      )
      .all(CHAT_X)
      .map((row) => String(row.detail))
    const inboxPlan = db.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM messages
         WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
           AND NOT ${runOwnsDirectMessageSql('messages')}`
      )
      .all(CHAT_X)
      .map((row) => String(row.detail))

    for (const plan of [ownerPlan, inboxPlan]) {
      expect(
        plan.some((detail) => /\bSCAN\b.*\b(worker_dispatch|worker_resource)\b/.test(detail))
      ).toBe(false)
      expect(plan).toContainEqual(
        expect.stringContaining('idx_dispatch_structured_process_incarnation')
      )
      expect(plan).toContainEqual(expect.stringContaining('idx_dispatch_assignee_orca_session_id'))
      expect(plan).toContainEqual(expect.stringContaining('idx_dispatch_creator_orca_session_id'))
      expect(plan).toContainEqual(expect.stringContaining('idx_worker_terminal_resources_identity'))
    }
  })

  it('probes message, task, and removed-dispatch proofs by index', () => {
    db = new OrchestrationDb(':memory:')
    const insertRemoved = db.db.prepare(
      `INSERT INTO removed_orchestration_work (run_id, kind, entity_id, record)
       VALUES (NULL, 'dispatch', ?, ?)`
    )
    db.db.exec('BEGIN')
    try {
      for (let i = 0; i < 200; i++) {
        insertRemoved.run(
          `disp_${i}`,
          JSON.stringify({
            assigneeHandle: `structworker_archive_${i}`,
            assigneeOrcaSessionId: `session_archive_${i}`,
            creatorHandle: `structworker_creator_${i}`,
            creatorOrcaSessionId: `session_creator_${i}`
          })
        )
      }
      db.db.exec('COMMIT')
    } catch (error) {
      db.db.exec('ROLLBACK')
      throw error
    }
    const checkBackfillPlan = () => {
      const plan = db!.db
        .prepare(`EXPLAIN QUERY PLAN ${coordinatorSessionAliasBackfillSql()}`)
        .all()
        .map((row) => String(row.detail))
        .join('\n')
      expect(plan).toMatch(
        /SEARCH messages USING COVERING INDEX idx_messages_structured_worker_sender_pane/
      )
      expect(plan).toMatch(/SEARCH tasks USING COVERING INDEX idx_tasks_structured_worker_creator/)
      expect(plan).toMatch(
        /SEARCH removed_orchestration_work USING INDEX idx_removed_dispatch_assignee_session/
      )
      expect(plan).toMatch(
        /SEARCH removed_orchestration_work USING INDEX idx_removed_dispatch_creator_session/
      )
      expect(plan).not.toContain('SCAN messages')
      expect(plan).not.toContain('SCAN tasks')
      expect(plan).not.toContain('SCAN removed_orchestration_work')
    }
    checkBackfillPlan()
    db.db.exec('ANALYZE')
    checkBackfillPlan()
  })
})
