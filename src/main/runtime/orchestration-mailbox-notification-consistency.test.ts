import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import { OrchestrationDb } from './orchestration/db'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  LAUNCH_TOKEN,
  LEAF_ID,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  registerSecondPane,
  SECOND_LAUNCH_TOKEN,
  SECOND_LEAF_ID,
  SECOND_PANE_KEY,
  SECOND_PTY_ID,
  SECOND_TERMINAL_HANDLE,
  sqliteFor,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { RpcDispatcher } from './rpc/dispatcher'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('orchestration notification mailbox consistency', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never points direct Run A mail after the pane is rebound to Run B', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-consistency-')
    const first = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    const staleDirectMessage = insertDirectRunMessage(db, runA.id, 'Run A completion')
    const runB = createBoundRun(db, 'Run B')

    await driveToLiveIdle(first.runtime)
    const checked = await checkBoundMailbox(first.runtime)
    const mismatch = pointerCount(first.write) > 0 && checked.count === 0

    expect(mismatch).toBe(false)
    expect(checked).toMatchObject({
      runId: runB.id,
      deliveryId: null,
      count: 0,
      messages: []
    })
    expect(db.getMessageById(staleDirectMessage.id)).toMatchObject({
      read: 0,
      delivered_at: null
    })
    db.close()
  })

  it('does not point unbound direct mail that a later Run binding would hide', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-unbound-bind-race-')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Unbound Run A')
    const message = insertDirectRunMessage(db, runA.id, 'Run A before later binding')
    db.bindRun({
      runId: runA.id,
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(TERMINAL_HANDLE, message.id)

    await driveToLiveIdle(harness.runtime)
    const runB = createBoundRun(db, 'Later Run B')
    const checked = await checkBoundMailbox(harness.runtime)

    expect(pointerCount(harness.write)).toBe(0)
    expect(checked).toMatchObject({ runId: runB.id, deliveryId: null, count: 0, messages: [] })
    expect(db.getMessageById(message.id)).toMatchObject({
      to_handle: TERMINAL_HANDLE,
      read: 0,
      delivered_at: null
    })
    db.close()
  })

  it('reconciles the persisted production mismatch after runtime restart', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-upgrade-restart-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const oldDb = new OrchestrationDb(dbPath)
    const runA = createBoundRun(oldDb, 'Persisted Run A')
    const message = insertDirectRunMessage(oldDb, runA.id, 'Persisted Run A completion')
    createBoundRun(oldDb, 'Persisted Run B')
    sqliteFor(oldDb)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(TERMINAL_HANDLE, message.id)
    oldDb.close()

    const restartedDb = new OrchestrationDb(dbPath)
    const restarted = createRuntime(restartedDb)
    await driveToLiveIdle(restarted.runtime)

    expect(pointerCount(restarted.write)).toBe(0)
    expect(restartedDb.getMessageById(message.id)).toMatchObject({
      to_handle: `run:${runA.id}`,
      read: 0,
      delivered_at: null
    })

    registerSecondPane(restarted.runtime)
    restartedDb.bindRun({
      runId: runA.id,
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    restarted.runtime.onPtyData(SECOND_PTY_ID, '\x1b]0;Codex working\x07', 1)
    restarted.runtime.onPtyData(SECOND_PTY_ID, '\x1b]0;Codex done\x07', 2)
    const checked = await checkBoundMailbox(restarted.runtime, {
      terminal: SECOND_TERMINAL_HANDLE,
      paneKey: SECOND_PANE_KEY,
      launchToken: SECOND_LAUNCH_TOKEN
    })

    expect(checked).toMatchObject({ runId: runA.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    restartedDb.close()
  })

  it('pages a large persisted mismatch and coalesces each mailbox wake', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-paged-reconciliation-')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Backlog Run A')
    const messages = Array.from({ length: 151 }, (_, index) =>
      insertDirectRunMessage(db, runA.id, `Backlog message ${index}`)
    )
    createBoundRun(db, 'Backlog Run B')
    const placeholders = messages.map(() => '?').join(',')
    sqliteFor(db)
      .prepare(`UPDATE messages SET to_handle = ? WHERE id IN (${placeholders})`)
      .run(TERMINAL_HANDLE, ...messages.map((message) => message.id))
    const notify = vi.spyOn(harness.runtime, 'notifyMessageArrived')
    const directRemaining = (): number =>
      (
        sqliteFor(db)
          .prepare('SELECT COUNT(*) AS count FROM messages WHERE to_handle = ?')
          .get(TERMINAL_HANDLE) as { count: number }
      ).count

    await driveToLiveIdle(harness.runtime)
    expect(directRemaining()).toBe(101)
    expect(notify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersToNextTimerAsync()
    expect(directRemaining()).toBe(51)
    expect(notify).toHaveBeenCalledTimes(2)
    await vi.advanceTimersToNextTimerAsync()
    expect(directRemaining()).toBe(1)
    expect(notify).toHaveBeenCalledTimes(3)
    await vi.advanceTimersToNextTimerAsync()
    expect(directRemaining()).toBe(0)
    expect(notify).toHaveBeenCalledTimes(4)
    expect(pointerCount(harness.write)).toBe(0)
    db.close()
  })

  it('uses composite indexes for direct ownership reconciliation', () => {
    const db = createDatabase('orca-mailbox-routing-indexes-')
    const sqlite = sqliteFor(db)
    const plan = (sql: string, ...params: string[]): string =>
      (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((row) => row.detail)
        .join(' ')

    expect(
      plan(
        `SELECT * FROM dispatch_contexts
         WHERE run_id = ? AND assignee_handle = ? AND status IN ('pending', 'dispatched')
         ORDER BY rowid DESC LIMIT 1`,
        'run_indexed',
        TERMINAL_HANDLE
      )
    ).toContain('idx_dispatch_active_run_assignee_handle')
    expect(
      plan(
        `SELECT * FROM dispatch_contexts
         WHERE run_id = ? AND assignee_pane_key IS NOT NULL
           AND status IN ('pending', 'dispatched') AND instr(assignee_pane_key, ':') > 1
           AND substr(assignee_pane_key, instr(assignee_pane_key, ':') + 1) = ?
         ORDER BY rowid DESC LIMIT 1`,
        'run_indexed',
        LEAF_ID
      )
    ).toContain('idx_dispatch_active_run_pane_leaf')
    expect(
      plan(
        `SELECT 1 FROM messages INDEXED BY idx_messages_undelivered_direct_run
         WHERE run_id = ? AND to_handle = ? AND read = 0 AND delivered_at IS NULL
           AND delivery_contract = 'current_delivery' LIMIT 1`,
        'run_indexed',
        TERMINAL_HANDLE
      )
    ).toContain('idx_messages_undelivered_direct_run')
    expect(
      plan(
        `SELECT * FROM messages INDEXED BY idx_messages_unread_current_run_type
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery' AND type IN (?)
         ORDER BY sequence LIMIT 100`,
        'run_indexed',
        'run:run_indexed',
        'worker_done'
      )
    ).toContain('idx_messages_unread_current_run_type')
    db.close()
  })

  it('finds owned mail without scanning an older unowned direct backlog', () => {
    const db = createDatabase('orca-mailbox-owned-routing-plan-')
    const detachedHandle = 'term_backlogged_detached'
    const ownedRun = db.createRun({
      objective: 'Owned after backlog',
      coordinatorHandle: detachedHandle,
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const unownedRun = createBoundRun(db, 'Unowned backlog')
    for (let index = 0; index < 500; index += 1) {
      db.insertMessage({
        from: TERMINAL_HANDLE,
        to: detachedHandle,
        subject: `Unowned ${index}`,
        type: 'status',
        runId: unownedRun.id,
        deliveryContract: 'current_delivery'
      })
    }
    const owned = db.insertMessage({
      from: 'term_worker',
      to: detachedHandle,
      subject: 'Owned after unowned backlog',
      type: 'worker_done',
      runId: ownedRun.id,
      deliveryContract: 'current_delivery'
    })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(detachedHandle, owned.id)
    const prepare = vi.spyOn(sqliteFor(db), 'prepare')

    expect(db.routeForeignDirectMessagesToOwnedMailboxes(detachedHandle)).toMatchObject({
      routedCount: 1,
      hasMore: false
    })

    const routingSql = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('FROM run_coordinator_handles AS coordinator'))
    expect(routingSql).toContain('INDEXED BY idx_messages_undelivered_direct_run')
    expect(routingSql).not.toContain('NOT EXISTS')
    expect(db.getMessageById(owned.id)?.to_handle).toBe(`run:${ownedRun.id}`)
    expect(db.getUnreadDirectMessageTypes(detachedHandle)).toEqual(['status'])
    db.close()
  })

  it('does not submit or replay a pointer after ownership changes during Enter delay', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-restart-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = createRuntime(firstDb)
    const runA = createBoundRun(firstDb, 'Run A')
    const message = insertDirectRunMessage(firstDb, runA.id, 'Run A completion')
    await driveToLiveIdle(first.runtime)
    expect(pointerCount(first.write)).toBe(1)

    const runB = createBoundRun(firstDb, 'Run B')
    await vi.advanceTimersByTimeAsync(500)
    expect(first.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(firstDb.getMessageById(message.id)?.delivered_at).toBeNull()
    firstDb.close()

    const restartedDb = new OrchestrationDb(dbPath)
    const restarted = createRuntime(restartedDb)
    await driveToLiveIdle(restarted.runtime)
    const checked = await checkBoundMailbox(restarted.runtime)
    const replayedMismatch = pointerCount(restarted.write) > 0 && checked.count === 0

    expect(replayedMismatch).toBe(false)
    expect(checked).toMatchObject({ runId: runB.id, deliveryId: null, count: 0, messages: [] })
    expect(restartedDb.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: null
    })
    restartedDb.close()
  })

  it('does not replay a staged same-Run pointer when the runtime restarts before Enter', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-staged-restart-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = createRuntime(firstDb)
    const run = createBoundRun(firstDb, 'Staged restart Run')
    const message = insertDirectRunMessage(firstDb, run.id, 'Visible before restart')

    await driveToLiveIdle(first.runtime)
    expect(pointerCount(first.write)).toBe(1)
    expect(first.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(firstDb.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    firstDb.close()

    const restartedDb = new OrchestrationDb(dbPath)
    const restarted = createRuntime(restartedDb)
    await driveToLiveIdle(restarted.runtime)
    const checked = await checkBoundMailbox(restarted.runtime)

    expect(pointerCount(restarted.write)).toBe(0)
    expect(checked).toMatchObject({ runId: run.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    restartedDb.close()
  })

  it('fences the pointed mailbox instead of checking a rebound empty Run', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-post-submit-rebind-')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    insertDirectRunMessage(db, runA.id, 'Run A completion')

    await driveToLiveIdle(harness.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining(`orchestration check --run ${runA.id}`)
    )

    db.bindRun({
      runId: runA.id,
      coordinatorHandle: 'term_new_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const runB = createBoundRun(db, 'Run B')
    const response = await new RpcDispatcher({
      runtime: harness.runtime,
      methods: ORCHESTRATION_METHODS
    }).dispatch({
      id: 'req-pointed-mailbox-fenced',
      authToken: 'test-auth-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationCompatibilityEvidence: {
        terminalHandle: TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: LAUNCH_TOKEN
      },
      params: { terminal: TERMINAL_HANDLE, run: runA.id }
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
    const generic = await checkBoundMailbox(harness.runtime)
    expect(generic).toMatchObject({ runId: runB.id, count: 0 })
    db.close()
  })

  it('releases a staged pointer when its Run moves to another live pane', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-live-rebind-')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    const message = insertDirectRunMessage(db, runA.id, 'Run A completion')
    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)

    createBoundRun(db, 'Run B')
    registerSecondPane(harness.runtime, SECOND_LEAF_ID, false)
    db.bindRun({
      runId: runA.id,
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    harness.runtime.onPtyData(SECOND_PTY_ID, '\x1b]0;Codex working\x07', 1)
    harness.runtime.onPtyData(SECOND_PTY_ID, '\x1b]0;Codex done\x07', 2)
    await vi.advanceTimersByTimeAsync(500)

    expect(
      harness.write.mock.calls.filter(
        ([ptyId, payload]) =>
          ptyId === SECOND_PTY_ID && String(payload).includes('orca orchestration check')
      )
    ).toHaveLength(1)
    expect(
      harness.write.mock.calls.filter(([ptyId, payload]) => ptyId === PTY_ID && payload === '\r')
    ).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(harness.runtime, {
      terminal: SECOND_TERMINAL_HANDLE,
      paneKey: SECOND_PANE_KEY,
      launchToken: SECOND_LAUNCH_TOKEN
    })
    expect(checked).toMatchObject({ runId: runA.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    db.close()
  })

  it('serializes equivalent panes while newer mail arrives during Enter delay', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-equivalent-pane-flight-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Equivalent pane Run')
    const first = insertDirectRunMessage(db, run.id, 'First status')
    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)

    registerSecondPane(harness.runtime, LEAF_ID)
    const second = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'Second status',
      runId: run.id
    })
    harness.runtime.onPtyData(SECOND_PTY_ID, '\x1b]0;Codex working\x07', 1)
    harness.runtime.onPtyData(SECOND_PTY_ID, '\x1b]0;Codex done\x07', 2)
    await Promise.resolve()
    expect(
      harness.write.mock.calls.filter(
        ([ptyId, payload]) =>
          ptyId === SECOND_PTY_ID && String(payload).includes('orca orchestration check')
      )
    ).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(500)
    expect(
      harness.write.mock.calls.filter(
        ([ptyId, payload]) =>
          ptyId === PTY_ID && String(payload).includes('orca orchestration check')
      )
    ).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(500)

    const checked = await checkBoundMailbox(harness.runtime)
    expect(checked).toMatchObject({ runId: run.id, count: 2 })
    expect(checked.messages).toEqual(
      [first, second].map((message) => expect.objectContaining({ id: message.id }))
    )
    db.close()
  })

  it('does not submit or duplicate a pointer after the agent becomes working', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-working-before-enter-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Working-before-Enter Run')
    const message = insertDirectRunMessage(db, run.id, 'Actionable status')

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 3)
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 4)
    await Promise.resolve()
    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })

  it('releases staged pointer state when an explicit check owns the batch', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-explicit-check-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Explicit-check Run')
    insertDirectRunMessage(db, run.id, 'Checked before Enter')

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    const checked = await checkBoundMailbox(harness.runtime)
    expect(checked).toMatchObject({ runId: run.id, count: 1 })

    await vi.advanceTimersByTimeAsync(500)
    const redrive = vi.spyOn(harness.runtime, 'deliverPendingMessagesForHandle')
    harness.runtime.onPtyExit(PTY_ID, 0)
    await Promise.resolve()
    expect(redrive).not.toHaveBeenCalled()
    db.close()
  })

  it('routes same-Run direct mail through the bound check and acknowledgment path', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-current-run-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Current Run')
    const messages = Array.from({ length: 51 }, (_, index) =>
      db.insertMessage({
        from: 'term_worker',
        to: TERMINAL_HANDLE,
        subject: `Direct coordinator status ${index}`,
        runId: run.id
      })
    )
    const notificationQuery = vi.spyOn(db, 'getUndeliveredUnreadMessages')
    const submitRevalidation = vi.spyOn(db, 'areUnreadMessages')
    const prepare = vi.spyOn(sqliteFor(db), 'prepare')

    await driveToLiveIdle(harness.runtime)
    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(harness.runtime)

    expect(pointerCount(harness.write)).toBe(1)
    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining('You have 50 orchestration messages')
    )
    expect(notificationQuery.mock.results[0]?.value).toHaveLength(50)
    expect(submitRevalidation).toHaveBeenCalledWith(
      `run:${run.id}`,
      messages.slice(0, 50).map((message) => message.id)
    )
    const revalidationSql = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('SELECT COUNT(*)') && sql.includes('id IN'))
    expect(revalidationSql).toContain('INDEXED BY idx_messages_id')
    const revalidationPlan = sqliteFor(db)
      .prepare(`EXPLAIN QUERY PLAN ${revalidationSql}`)
      .all(`run:${run.id}`, ...messages.slice(0, 50).map((message) => message.id)) as {
      detail: string
    }[]
    expect(revalidationPlan.map((row) => row.detail).join(' ')).toContain('idx_messages_id')
    expect(checked).toMatchObject({ runId: run.id, count: 50 })
    expect(checked.deliveryId).toBeTruthy()
    expect(checked.messages).toEqual(
      messages.slice(0, 50).map((message) => expect.objectContaining({ id: message.id }))
    )
    expect(db.getMessageById(messages[0]!.id)).toMatchObject({
      to_handle: `run:${run.id}`,
      read: 0,
      delivered_at: expect.any(String)
    })
    expect(db.getMessageById(messages[50]!.id)?.delivered_at).toBeNull()

    const acknowledged = await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })
    expect(acknowledged.acknowledged).toBe(checked.deliveryId)
    expect(acknowledged.messages).toEqual([expect.objectContaining({ id: messages[50]!.id })])
    expect(db.getMessageById(messages[0]!.id)?.read).toBe(1)
    db.close()
  })

  it('does not replay a successfully submitted actionable pointer after restart', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-actionable-restart-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = createRuntime(firstDb)
    const run = createBoundRun(firstDb, 'Restart-safe Run')
    const message = insertDirectRunMessage(firstDb, run.id, 'Actionable status')

    await driveToLiveIdle(first.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(first.write)).toBe(1)
    expect(firstDb.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: expect.any(String)
    })
    firstDb.close()

    const restartedDb = new OrchestrationDb(dbPath)
    const restarted = createRuntime(restartedDb)
    await driveToLiveIdle(restarted.runtime)
    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(restarted.runtime)

    expect(pointerCount(restarted.write)).toBe(0)
    expect(checked).toMatchObject({ runId: run.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    expect(checked.deliveryId).toBeTruthy()
    restartedDb.close()
  })

  it('does not replay a visible pointer when the provider rejects Enter', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-provider-refusal-')
    const first = createRuntime(db)
    const recordWrite = first.write as unknown as (id: string, payload: string) => unknown
    const write = vi.fn((ptyId: string, data: string) => {
      recordWrite(ptyId, data)
      return data !== '\r'
    })
    first.runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    const run = createBoundRun(db, 'Provider-refusal Run')
    const message = insertDirectRunMessage(db, run.id, 'Retry after refusal')

    await driveToLiveIdle(first.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(first.write)).toBe(1)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))

    const restarted = createRuntime(db)
    await driveToLiveIdle(restarted.runtime)
    expect(pointerCount(restarted.write)).toBe(0)
    db.close()
  })

  it('does not point newer Run mail behind an outstanding Delivery', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-outstanding-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Outstanding Delivery Run')
    const firstMessage = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'First status',
      runId: run.id
    })
    const firstDelivery = await checkBoundMailbox(harness.runtime)
    const newerMessage = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'Newer status',
      runId: run.id
    })

    await driveToLiveIdle(harness.runtime)
    const replayed = await checkBoundMailbox(harness.runtime)

    expect(pointerCount(harness.write)).toBe(0)
    expect(replayed.messages).toEqual([expect.objectContaining({ id: firstMessage.id })])
    expect(replayed.deliveryId).toBe(firstDelivery.deliveryId)

    const next = await checkBoundMailbox(harness.runtime, { ack: firstDelivery.deliveryId! })
    expect(next.messages).toEqual([expect.objectContaining({ id: newerMessage.id })])
    expect(next.deliveryId).not.toBe(firstDelivery.deliveryId)
    db.close()
  })

  it('drains persisted Run pages before installing a filtered waiter', async () => {
    const db = createDatabase('orca-mailbox-filtered-run-backlog-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Filtered Run backlog')
    for (let index = 0; index < 50; index += 1) {
      insertDirectRunMessage(db, run.id, `Status ${index}`)
    }
    const question = db.insertMessage({
      from: 'term_worker',
      to: TERMINAL_HANDLE,
      subject: 'Question behind first page',
      type: 'question',
      runId: run.id
    })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(TERMINAL_HANDLE, question.id)

    const checked = await checkBoundMailbox(harness.runtime, {
      wait: true,
      types: 'question'
    })

    expect(checked).toMatchObject({ runId: run.id, count: 50 })
    expect(checked.messages).not.toContainEqual(expect.objectContaining({ id: question.id }))
    expect(db.getMessageById(question.id)?.to_handle).toBe(`run:${run.id}`)
    const next = await checkBoundMailbox(harness.runtime, {
      ack: checked.deliveryId!,
      types: 'question'
    })
    expect(next.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: question.id })])
    )
    db.close()
  })

  it('wakes a filtered waiter when reconciliation moves its type on a later page', async () => {
    const db = createDatabase('orca-mailbox-filtered-reconciliation-wake-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Filtered reconciliation wake')
    const waiting = checkBoundMailbox(harness.runtime, { wait: true, types: 'question' })
    const internals = harness.runtime as unknown as {
      messageWaitersByHandle: Map<string, Set<unknown>>
    }
    await vi.waitFor(() => {
      expect(internals.messageWaitersByHandle.has(`run:${run.id}`)).toBe(true)
    })
    for (let index = 0; index < 50; index += 1) {
      insertDirectRunMessage(db, run.id, `Status before question ${index}`)
    }
    const question = db.insertMessage({
      from: 'term_worker',
      to: TERMINAL_HANDLE,
      subject: 'Question moved by continuation',
      type: 'question',
      runId: run.id
    })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(TERMINAL_HANDLE, question.id)
    const arrivingStatus = insertDirectRunMessage(db, run.id, 'Status arrival trigger')

    harness.runtime.notifyMessageArrived(TERMINAL_HANDLE, arrivingStatus.type)
    const checked = await waiting

    expect(checked).toMatchObject({ runId: run.id, count: 50 })
    expect(checked.messages).not.toContainEqual(expect.objectContaining({ id: question.id }))
    expect(db.getMessageById(question.id)?.to_handle).toBe(`run:${run.id}`)
    const next = await checkBoundMailbox(harness.runtime, {
      ack: checked.deliveryId!,
      types: 'question'
    })
    expect(next.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: question.id })])
    )
    db.close()
  })

  it('drains persisted Dispatch pages before installing a filtered waiter', async () => {
    const db = createDatabase('orca-mailbox-filtered-dispatch-backlog-')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Filtered Dispatch backlog',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const task = db.createTask({ spec: 'Worker task', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    for (let index = 0; index < 50; index += 1) {
      insertDirectRunMessage(db, run.id, `Worker status ${index}`)
    }
    const question = db.insertMessage({
      from: 'term_coordinator',
      to: TERMINAL_HANDLE,
      subject: 'Worker question behind first page',
      type: 'question',
      runId: run.id
    })

    const checked = await checkBoundMailbox(harness.runtime, {
      wait: true,
      types: 'question'
    })

    expect(checked).toMatchObject({ runId: run.id, dispatchId: dispatch.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: question.id })])
    expect(db.getMessageById(question.id)?.to_handle).toBe(`dispatch:${dispatch.id}`)
    db.close()
  })
})
