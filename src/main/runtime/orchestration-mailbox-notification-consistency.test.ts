import './rpc/unused-default-rpc-methods.test-fixture'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import './orchestration/db/contract-constants'
import './orchestration/db/messages/mailbox-routing-page'
import './orchestration/db/dispatch-row-writer'
import './orchestration/db/attempt-outcome-projection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import {
  checkBoundMailbox,
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  isMailboxPointer,
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
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration/orchestration'
import { MAILBOX_POINTER_WRITE_ATTEMPTED } from './orchestration/db/messages/mailbox-pointer-enter-state'

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
    const db = new OrchestrationDb(':memory:')
    const first = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    const staleDirectMessage = insertDirectRunMessage(db, runA.id, 'Run A completion')
    const runB = createBoundRun(db, 'Run B', { rebind: true })

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

  it('reconciles the persisted production mismatch after runtime restart', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-upgrade-restart-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const oldDb = new OrchestrationDb(dbPath)
    const runA = createBoundRun(oldDb, 'Persisted Run A')
    const message = insertDirectRunMessage(oldDb, runA.id, 'Persisted Run A completion')
    createBoundRun(oldDb, 'Persisted Run B', { rebind: true })
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

  it('finds owned mail without scanning an older unowned direct backlog', () => {
    const db = new OrchestrationDb(':memory:')
    const detachedHandle = 'term_backlogged_detached'
    const ownedRun = db.createRun({
      objective: 'Owned after backlog',
      coordinatorHandle: detachedHandle,
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const unownedRun = createBoundRun(db, 'Unowned backlog')
    for (let index = 0; index < 51; index += 1) {
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
    // An anti-join per coordinator row is fine; one per candidate message would scan the backlog.
    expect(routingSql).not.toMatch(/NOT EXISTS \([^)]*candidate\./)
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

    const runB = createBoundRun(firstDb, 'Run B', { rebind: true })
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

  it('does not replay Enter for an ambiguous staged pointer after restart', async () => {
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
    expect(firstDb.getMessageById(message.id)?.delivered_at).toBeNull()
    expect(firstDb.getPendingMailboxPointerMessages(`run:${run.id}`)).toEqual([
      expect.objectContaining({
        id: message.id,
        pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED,
        pointer_pty_id: PTY_ID,
        pointer_process_incarnation: `${PTY_ID}:mailbox-incarnation`
      })
    ])
    firstDb.close()

    const restartedDb = new OrchestrationDb(dbPath)
    const restarted = createRuntime(restartedDb)
    await restarted.runtime.listTerminals()
    restarted.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 3)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(restarted.runtime)

    expect(pointerCount(restarted.write)).toBe(0)
    expect(restarted.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(checked).toMatchObject({ runId: run.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    restartedDb.close()
  })

  it('never resumes a staged Enter after the restored agent starts working', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-working-restart-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = createRuntime(firstDb)
    const run = createBoundRun(firstDb, 'Working restart Run')
    const message = insertDirectRunMessage(firstDb, run.id, 'Do not submit stale Enter')

    await driveToLiveIdle(first.runtime)
    expect(pointerCount(first.write)).toBe(1)
    firstDb.close()

    const restartedDb = new OrchestrationDb(dbPath)
    const restarted = createRuntime(restartedDb)
    await restarted.runtime.listTerminals()
    restarted.runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 3)
    await vi.advanceTimersByTimeAsync(500)

    expect(restarted.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(restartedDb.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    restarted.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 4)
    await Promise.resolve()
    expect(pointerCount(restarted.write)).toBe(0)
    restartedDb.close()
  })

  it('fences the pointed mailbox instead of checking a rebound empty Run', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
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
    const db = new OrchestrationDb(':memory:')
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
        ([ptyId, payload]) => ptyId === SECOND_PTY_ID && isMailboxPointer(payload)
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

  // Main remints duplicate leaf ids at load, so equivalent-pane serialization applies only to window-owned layouts.
  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'serializes equivalent panes while newer mail arrives during Enter delay',
    async () => {
      vi.useFakeTimers()
      const db = new OrchestrationDb(':memory:')
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
          ([ptyId, payload]) => ptyId === SECOND_PTY_ID && isMailboxPointer(payload)
        )
      ).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(500)
      expect(
        harness.write.mock.calls.filter(
          ([ptyId, payload]) => ptyId === PTY_ID && isMailboxPointer(payload)
        )
      ).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(500)

      const checked = await checkBoundMailbox(harness.runtime)
      expect(checked).toMatchObject({ runId: run.id, count: 2 })
      expect(checked.messages).toEqual(
        [first, second].map((message) => expect.objectContaining({ id: message.id }))
      )
      db.close()
    }
  )

  it.each([
    ['Codex', '\x1b]0;Codex working\x07', '\x1b]0;Codex done\x07'],
    ['Claude', '\x1b]0;\u280b Claude working\x07', '\x1b]0;\u2733 Claude Code\x07']
  ])(
    'submits a staged pointer after %s becomes working without duplicating it',
    async (_provider, workingTitle, idleTitle) => {
      vi.useFakeTimers()
      const db = new OrchestrationDb(':memory:')
      const harness = createRuntime(db)
      const run = createBoundRun(db, 'Working-before-Enter Run')
      const message = insertDirectRunMessage(db, run.id, 'Actionable status')

      await driveToLiveIdle(harness.runtime)
      expect(pointerCount(harness.write)).toBe(1)
      harness.runtime.onPtyData(PTY_ID, workingTitle, 3)
      await vi.advanceTimersByTimeAsync(500)

      expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
      expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
      harness.runtime.onPtyData(PTY_ID, idleTitle, 4)
      await Promise.resolve()
      expect(pointerCount(harness.write)).toBe(1)
      db.close()
    }
  )

  it.each([
    ['Codex', '\x1b]0;Codex permission\x07'],
    ['Claude', '\x1b]0;Claude waiting for permission\x07']
  ])(
    'does not submit a staged pointer after %s enters a permission state',
    async (_provider, permissionTitle) => {
      vi.useFakeTimers()
      const db = new OrchestrationDb(':memory:')
      const harness = createRuntime(db)
      const run = createBoundRun(db, 'Permission-before-Enter Run')
      const message = insertDirectRunMessage(db, run.id, 'Actionable status')

      await driveToLiveIdle(harness.runtime)
      expect(pointerCount(harness.write)).toBe(1)
      harness.runtime.onPtyData(PTY_ID, permissionTitle, 3)
      await vi.advanceTimersByTimeAsync(500)

      expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
      expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
      db.close()
    }
  )
  it('submits a staged pointer once when a live PTY is cold-parked before Enter', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Cold-park Run')
    const message = insertDirectRunMessage(db, run.id, 'Submit while parked')

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    harness.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await vi.advanceTimersByTimeAsync(500)

    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    db.close()
  })

  it.each([
    ['working', '\x1b]0;Codex working\x07', '\x1b]0;Codex done\x07'],
    ['permission', '\x1b]0;Codex waiting for permission\x07', '\x1b]0;Codex done\x07']
  ])(
    'handles a cold-parked pointer after the agent becomes %s',
    async (state, title, idleTitle) => {
      vi.useFakeTimers()
      const db = new OrchestrationDb(':memory:')
      const harness = createRuntime(db)
      const run = createBoundRun(db, 'Cold-park transition Run')
      const message = insertDirectRunMessage(db, run.id, 'Do not submit while unavailable')

      await driveToLiveIdle(harness.runtime)
      expect(pointerCount(harness.write)).toBe(1)
      harness.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      harness.runtime.onPtyData(PTY_ID, title, 3)

      await vi.advanceTimersByTimeAsync(500)

      expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
      if (state === 'working') {
        harness.runtime.onPtyData(PTY_ID, idleTitle, 4)
        await Promise.resolve()
        await Promise.resolve()
        expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
        await vi.waitFor(() =>
          expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
        )
      } else {
        expect(db.getMessageById(message.id)?.delivered_at).toBeNull()
      }
      db.close()
    }
  )

  it('routes same-Run direct mail through the bound check and acknowledgment path', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
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
      read: 1,
      delivered_at: expect.any(String)
    })
    expect(db.getMessageById(messages[50]!.id)?.delivered_at).toBeNull()

    const acknowledged = await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })
    expect(acknowledged.acknowledged).toBe(checked.deliveryId)
    const next = await checkBoundMailbox(harness.runtime)
    expect(next.messages).toEqual([expect.objectContaining({ id: messages[50]!.id })])
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
    const db = new OrchestrationDb(':memory:')
    const first = createRuntime(db)
    const recordWrite = first.write as unknown as (id: string, payload: string) => unknown
    const write = vi.fn((ptyId: string, data: string) => {
      recordWrite(ptyId, data)
      return data !== '\r'
    })
    first.runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
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
    const checked = await checkBoundMailbox(restarted.runtime)
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    db.close()
  })

  it('points newer Run mail with the normal text when the coordinator never acked', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Never-acked Run')
    const insert = (subject: string) =>
      db.insertMessage({ from: 'term_worker', to: `run:${run.id}`, subject, runId: run.id })
    const firstMessage = insert('First status')
    const firstDelivery = await checkBoundMailbox(harness.runtime)
    expect(firstDelivery.messages).toEqual([expect.objectContaining({ id: firstMessage.id })])
    const newerMessage = insert('Newer status')

    await driveToLiveIdle(harness.runtime)
    const pointers = harness.write.mock.calls.filter(([, payload]) => isMailboxPointer(payload))
    expect(pointers).toHaveLength(1)
    expect(String(pointers[0]![1])).toContain('You have 1 orchestration message.')
    expect(String(pointers[0]![1])).not.toContain('acknowledged')

    const next = await checkBoundMailbox(harness.runtime)
    expect(next.messages).toEqual([expect.objectContaining({ id: newerMessage.id })])
    expect(next.deliveryId).not.toBe(firstDelivery.deliveryId)
    db.close()
  })
})
