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
import { pruneStaleChatCoordinatorAliases } from './run-coordinator-session-alias'

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
})
