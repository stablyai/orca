import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  LEAF_ID,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  sqliteFor,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('orchestration detached mailbox routing', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('routes active worker direct mail through a stable Dispatch pointer and Delivery', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-dispatch-')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Worker Run',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey:
        '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
    })
    const task = db.createTask({ spec: 'Worker task', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    await driveToLiveIdle(harness.runtime)
    const message = db.insertMessage({
      from: 'term_coordinator',
      to: TERMINAL_HANDLE,
      subject: 'Worker status',
      runId: run.id
    })

    harness.runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(harness.runtime)

    expect(pointerCount(harness.write)).toBe(1)
    expect(checked).toMatchObject({ runId: run.id, dispatchId: dispatch.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    expect(db.getMessageById(message.id)).toMatchObject({
      to_handle: `dispatch:${dispatch.id}`,
      read: 0,
      delivered_at: expect.any(String)
    })
    await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })
    expect(db.getMessageById(message.id)?.read).toBe(1)
    db.close()
  })

  it('normalizes direct mail that arrives while its Run is displaced', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-late-rebind-')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    const runB = createBoundRun(db, 'Run B')
    const rebound = db.bindRun({
      runId: runA.id,
      coordinatorHandle: 'term_new_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const waiting = harness.runtime.waitForMessage(`run:${runA.id}`, { timeoutMs: 5_000 })
    const message = db.insertMessage({
      from: 'term_worker',
      to: TERMINAL_HANDLE,
      subject: 'Late Run A status',
      runId: runA.id
    })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(TERMINAL_HANDLE, message.id)
    harness.runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
    await Promise.resolve()

    await expect(waiting).resolves.toBe('notified')
    expect(pointerCount(harness.write)).toBe(0)
    expect(db.getMessageById(message.id)?.to_handle).toBe(`run:${runA.id}`)
    expect(db.getCurrentRunForPane(PANE_KEY)?.id).toBe(runB.id)

    const delivery = db.getOrCreateRunDelivery({
      runId: runA.id,
      consumerGeneration: rebound!.consumer_generation
    })

    expect(delivery?.messages).toEqual([expect.objectContaining({ id: message.id })])
    db.close()
  })

  it('preserves an active Dispatch as owner of displaced direct mail', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-displaced-dispatch-')
    const harness = createRuntime(db)
    const workerRun = db.createRun({
      objective: 'Worker Run',
      coordinatorHandle: 'term_worker_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const task = db.createTask({ spec: 'Worker task', runId: workerRun.id })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_mailbox_before_remint',
      `99999999-9999-4999-8999-999999999999:${LEAF_ID}`
    )
    createBoundRun(db, 'Current coordinator Run')
    const waiting = harness.runtime.waitForMessage(`dispatch:${dispatch.id}`, {
      timeoutMs: 5_000
    })
    const message = db.insertMessage({
      from: 'term_worker_coordinator',
      to: TERMINAL_HANDLE,
      subject: 'Late worker instruction',
      runId: workerRun.id
    })

    harness.runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
    await expect(waiting).resolves.toBe('notified')
    expect(pointerCount(harness.write)).toBe(0)
    expect(db.getMessageById(message.id)?.to_handle).toBe(`dispatch:${dispatch.id}`)

    const currentRun = db.getCurrentRunForPane(PANE_KEY)
    db.bindRun({
      runId: currentRun!.id,
      coordinatorHandle: 'term_rebound_coordinator',
      coordinatorPaneKey:
        '77777777-7777-4777-8777-777777777777:88888888-8888-4888-8888-888888888888'
    })
    const checked = await checkBoundMailbox(harness.runtime)
    expect(checked).toMatchObject({ runId: workerRun.id, dispatchId: dispatch.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    db.close()
  })

  it('uses bounded ownership lookup for direct arrivals while the agent is working', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-bounded-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Working Run')
    await harness.runtime.listTerminals()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
    const fullMailboxScan = vi.spyOn(db, 'getUndeliveredUnreadMessages')
    const message = insertDirectRunMessage(db, run.id, 'Direct coordinator status')

    harness.runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
    await Promise.resolve()

    expect(fullMailboxScan).not.toHaveBeenCalled()
    expect(pointerCount(harness.write)).toBe(0)
    expect(db.getMessageById(message.id)?.to_handle).toBe(`run:${run.id}`)
    db.close()
  })

  it('wakes a bound Run waiter when same-Run direct mail arrives', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-waiter-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Waiting Run')
    await driveToLiveIdle(harness.runtime)

    const waiting = checkBoundMailbox(harness.runtime, { wait: true })
    const internals = harness.runtime as unknown as {
      messageWaitersByHandle: Map<string, Set<unknown>>
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (internals.messageWaitersByHandle.has(`run:${run.id}`)) {
        break
      }
      await Promise.resolve()
    }
    expect(internals.messageWaitersByHandle.has(`run:${run.id}`)).toBe(true)

    const message = insertDirectRunMessage(db, run.id, 'Wake the Run waiter')
    harness.runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(waiting).resolves.toMatchObject({
      runId: run.id,
      count: 1,
      messages: [expect.objectContaining({ id: message.id })]
    })
    expect(pointerCount(harness.write)).toBe(0)
    db.close()
  })

  it('routes a stale-leaf arrival to its bound Run waiter', async () => {
    const db = createDatabase('orca-mailbox-stale-leaf-waiter-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Stale leaf waiter')
    const waiting = checkBoundMailbox(harness.runtime, { wait: true })
    const waiterInternals = harness.runtime as unknown as {
      messageWaitersByHandle: Map<string, Set<unknown>>
    }
    await vi.waitFor(() => {
      expect(waiterInternals.messageWaitersByHandle.has(`run:${run.id}`)).toBe(true)
    })
    const internals = harness.runtime as unknown as { leaves: Map<string, unknown> }
    internals.leaves.clear()
    const message = insertDirectRunMessage(db, run.id, 'Arrived during graph remount')

    harness.runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)

    await expect(waiting).resolves.toMatchObject({
      runId: run.id,
      count: 1,
      messages: [expect.objectContaining({ id: message.id })]
    })
    expect(db.getMessageById(message.id)?.to_handle).toBe(`run:${run.id}`)
    db.close()
  })

  it('keeps an unowned detached-recipient message in its direct mailbox', async () => {
    const db = createDatabase('orca-mailbox-detached-direct-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Detached direct recipient')
    const detachedHandle = 'term_detached_worker'
    const waiting = harness.runtime.waitForMessage(detachedHandle, { timeoutMs: 5_000 })
    const message = db.insertMessage({
      from: TERMINAL_HANDLE,
      to: detachedHandle,
      subject: 'Instruction before Dispatch ownership exists',
      type: 'dispatch',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })

    harness.runtime.notifyMessageArrived(detachedHandle, message.type)

    await expect(waiting).resolves.toBe('notified')
    expect(db.getMessageById(message.id)?.to_handle).toBe(detachedHandle)
    db.close()
  })

  it('wakes canonical and direct waiters for mixed detached ownership', async () => {
    const db = createDatabase('orca-mailbox-detached-mixed-')
    const harness = createRuntime(db)
    const detachedHandle = 'term_retired_coordinator'
    const ownedRun = db.createRun({
      objective: 'Retired coordinator ownership',
      coordinatorHandle: detachedHandle,
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const directRun = createBoundRun(db, 'Unowned detached recipient')
    const canonicalWait = harness.runtime.waitForMessage(`run:${ownedRun.id}`, {
      timeoutMs: 5_000
    })
    const directWait = harness.runtime.waitForMessage(detachedHandle, { timeoutMs: 5_000 })
    const owned = db.insertMessage({
      from: 'term_worker',
      to: detachedHandle,
      subject: 'Owned old coordinator mail',
      type: 'status',
      runId: ownedRun.id,
      deliveryContract: 'current_delivery'
    })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(detachedHandle, owned.id)
    const direct = db.insertMessage({
      from: TERMINAL_HANDLE,
      to: detachedHandle,
      subject: 'Unowned direct mail',
      type: 'status',
      runId: directRun.id,
      deliveryContract: 'current_delivery'
    })

    harness.runtime.notifyMessageArrived(detachedHandle, 'status')

    await expect(Promise.all([canonicalWait, directWait])).resolves.toEqual([
      'notified',
      'notified'
    ])
    expect(db.getMessageById(owned.id)?.to_handle).toBe(`run:${ownedRun.id}`)
    expect(db.getMessageById(direct.id)?.to_handle).toBe(detachedHandle)
    db.close()
  })

  it('does not wake a filtered direct waiter for a routed type', async () => {
    const db = createDatabase('orca-mailbox-detached-filtered-direct-')
    const harness = createRuntime(db)
    const detachedHandle = 'term_detached_filtered'
    const ownedRun = db.createRun({
      objective: 'Owned detached mail',
      coordinatorHandle: detachedHandle,
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const unownedRun = createBoundRun(db, 'Unowned detached mail')
    const waiting = harness.runtime.waitForMessage(detachedHandle, {
      typeFilter: ['worker_done'],
      timeoutMs: 5_000
    })
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    db.insertMessage({
      from: TERMINAL_HANDLE,
      to: detachedHandle,
      subject: 'Unowned status',
      type: 'status',
      runId: unownedRun.id,
      deliveryContract: 'current_delivery'
    })
    const owned = db.insertMessage({
      from: 'term_worker',
      to: detachedHandle,
      subject: 'Owned completion',
      type: 'worker_done',
      runId: ownedRun.id,
      deliveryContract: 'current_delivery'
    })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(detachedHandle, owned.id)

    harness.runtime.notifyMessageArrived(detachedHandle, owned.type)
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(db.getMessageById(owned.id)?.to_handle).toBe(`run:${ownedRun.id}`)
    harness.runtime.cancelMessageWaiters(detachedHandle)
    await expect(waiting).resolves.toBe('cancelled')
    db.close()
  })

  it('routes a stale-leaf reminted handle to its Dispatch waiter', async () => {
    const db = createDatabase('orca-mailbox-stale-leaf-reminted-dispatch-')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Reminted Dispatch',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const task = db.createTask({ spec: 'Reminted worker', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, 'term_before_remint', PANE_KEY)
    const waiting = harness.runtime.waitForMessage(`dispatch:${dispatch.id}`, {
      typeFilter: ['dispatch'],
      timeoutMs: 5_000
    })
    const internals = harness.runtime as unknown as { leaves: Map<string, unknown> }
    internals.leaves.clear()
    const message = db.insertMessage({
      from: 'term_coordinator',
      to: TERMINAL_HANDLE,
      subject: 'Instruction after remint',
      type: 'dispatch',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })

    harness.runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)

    await expect(waiting).resolves.toBe('notified')
    expect(db.getMessageById(message.id)?.to_handle).toBe(`dispatch:${dispatch.id}`)
    db.close()
  })

  it('deduplicates Dispatch ownership before limiting a routing page', () => {
    const db = createDatabase('orca-mailbox-duplicate-dispatch-owners-')
    const run = db.createRun({
      objective: 'Duplicate Dispatch ownership',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const task = db.createTask({ spec: 'Duplicate worker ownership', runId: run.id })
    const detachedHandle = 'term_duplicate_dispatch_owner'
    const sqlite = sqliteFor(db)
    const insertDispatch = sqlite.prepare(
      `INSERT INTO dispatch_contexts (id, run_id, task_id, assignee_handle, status)
       VALUES (?, ?, ?, ?, 'dispatched')`
    )
    for (let index = 0; index < 51; index += 1) {
      insertDispatch.run(`ctx_duplicate_${index}`, run.id, task.id, detachedHandle)
    }
    const messages = Array.from({ length: 52 }, (_, index) =>
      db.insertMessage({
        from: 'term_coordinator',
        to: detachedHandle,
        subject: `Dispatch message ${index}`,
        type: 'dispatch',
        runId: run.id,
        deliveryContract: 'current_delivery'
      })
    )

    expect(db.routeForeignDirectMessagesToOwnedMailboxes(detachedHandle)).toMatchObject({
      routedCount: 50,
      hasMore: true
    })
    expect(db.routeForeignDirectMessagesToOwnedMailboxes(detachedHandle)).toMatchObject({
      routedCount: 2,
      hasMore: false
    })
    expect(
      messages.every((message) => db.getMessageById(message.id)?.to_handle.startsWith('dispatch:'))
    ).toBe(true)
    db.close()
  })

  it('does not rebind active Dispatch mail through coordinator history', () => {
    const db = createDatabase('orca-mailbox-coordinator-dispatch-overlap-')
    const run = db.createRun({
      objective: 'Coordinator and Dispatch overlap',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    const task = db.createTask({ spec: 'Same-handle worker', runId: run.id })
    createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    const message = db.insertMessage({
      from: 'term_sender',
      to: TERMINAL_HANDLE,
      subject: 'Dispatch-owned mail',
      type: 'dispatch',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })

    db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_new_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })

    expect(db.getMessageById(message.id)?.to_handle).toBe(TERMINAL_HANDLE)
    db.close()
  })

  it('does not route active Dispatch mail through a paged Run check', () => {
    const db = createDatabase('orca-mailbox-paged-coordinator-dispatch-overlap-')
    const run = db.createRun({
      objective: 'Paged coordinator and Dispatch overlap',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    const task = db.createTask({ spec: 'Same-handle worker', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    const message = db.insertMessage({
      from: 'term_sender',
      to: TERMINAL_HANDLE,
      subject: 'Dispatch-owned paged mail',
      type: 'dispatch',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })

    expect(db.routeUnreadDirectMessagesToRunMailbox(run.id, TERMINAL_HANDLE)).toMatchObject({
      routedCount: 0,
      hasMore: false
    })
    expect(db.getMessageById(message.id)?.to_handle).toBe(TERMINAL_HANDLE)
    expect(
      db.routeUnreadDirectMessagesToDispatchMailbox(dispatch.id, run.id, TERMINAL_HANDLE)
    ).toMatchObject({ routedCount: 1, hasMore: false })
    expect(db.getMessageById(message.id)?.to_handle).toBe(`dispatch:${dispatch.id}`)
    db.close()
  })

  it('uses primary-key lookups for bounded routing updates', () => {
    const db = createDatabase('orca-mailbox-bounded-routing-indexes-')
    const sqlite = sqliteFor(db)
    const run = db.createRun({
      objective: 'Bounded routing indexes',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    const directMessage = db.insertMessage({
      from: 'term_sender',
      to: TERMINAL_HANDLE,
      subject: 'Direct Run mail',
      type: 'status',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    sqlite
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(TERMINAL_HANDLE, directMessage.id)
    const task = db.createTask({ spec: 'Dispatch migration', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, 'term_dispatch', PANE_KEY)
    db.insertMessage({
      from: 'term_sender',
      to: `dispatch:${dispatch.id}`,
      subject: 'Dispatch mailbox mail',
      type: 'status',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    const foreignHandle = 'term_foreign_bounded_routing'
    const foreignRun = db.createRun({
      objective: 'Foreign routing index',
      coordinatorHandle: foreignHandle,
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const foreignMessage = db.insertMessage({
      from: 'term_sender',
      to: foreignHandle,
      subject: 'Foreign direct mail',
      type: 'status',
      runId: foreignRun.id,
      deliveryContract: 'current_delivery'
    })
    sqlite
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(foreignHandle, foreignMessage.id)
    const prepare = vi.spyOn(sqlite, 'prepare')

    db.routeUnreadDirectMessagesToRunMailbox(run.id, TERMINAL_HANDLE)
    db.routeUnreadDispatchMailboxToRunMailbox(dispatch.id, run.id)
    db.routeForeignDirectMessagesToOwnedMailboxes(foreignHandle)

    const updateSql = [
      ...new Set(
        prepare.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => sql.includes('UPDATE messages') && sql.includes('id IN'))
      )
    ]
    expect(updateSql).toHaveLength(3)
    for (const sql of updateSql) {
      expect(sql).toContain('INDEXED BY idx_messages_id')
      const parameters = Array.from({ length: sql.split('?').length - 1 }, () => 'probe')
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as {
        detail: string
      }[]
      expect(plan.map((row) => row.detail).join(' ')).toContain('idx_messages_id')
    }
    db.close()
  })
})
