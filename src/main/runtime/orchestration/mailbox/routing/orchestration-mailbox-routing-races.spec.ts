import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../terminal-pointer/mailbox-pointer-state'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  registerSecondPane,
  SECOND_LAUNCH_TOKEN,
  SECOND_PANE_KEY,
  SECOND_TERMINAL_HANDLE,
  sqliteFor,
  temporaryDirectories,
  TERMINAL_HANDLE
} from '../terminal-pointer/orchestration-mailbox-notification-test-harness'
import {
  checkBoundMailbox,
  dispatchMailboxCheck
} from '../terminal-pointer/orchestration-mailbox-check.test-fixture'
import { ackThenCheck } from '../terminal-pointer/orchestration-mailbox-ack-then-check.test-fixture'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'

describe('orchestration mailbox routing races', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fences a Run consumer rebound during a routing-page yield', async () => {
    const db = createDatabase('orca-mailbox-run-routing-fence-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Run routing fence')
    for (let index = 0; index < 51; index += 1) {
      insertDirectRunMessage(db, run.id, `Before rebind ${index}`)
    }
    const route = db.routeUnreadDirectMessagesToRunMailbox.bind(db)
    let scheduled = false
    vi.spyOn(db, 'routeUnreadDirectMessagesToRunMailbox').mockImplementation((...args) => {
      const page = route(...args)
      if (page.hasMore && !scheduled) {
        scheduled = true
        setImmediate(() =>
          db.bindRun({
            runId: run.id,
            coordinatorHandle: 'term_replacement',
            coordinatorPaneKey: SECOND_PANE_KEY
          })
        )
      }
      return page
    })

    const response = await dispatchMailboxCheck(harness.runtime)

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(db.getUnreadMessages(`run:${run.id}`)).toHaveLength(51)
    db.close()
  })

  it('fences a Dispatch completed during a routing-page yield', async () => {
    const db = createDatabase('orca-mailbox-dispatch-routing-fence-')
    const harness = createRuntime(db)
    registerSecondPane(harness.runtime)
    const run = db.createRun({
      objective: 'Dispatch routing fence',
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    const task = db.createTask({ spec: 'Worker task', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    for (let index = 0; index < 151; index += 1) {
      insertDirectRunMessage(db, run.id, `Before completion ${index}`)
    }
    const route = db.routeUnreadDirectMessagesToDispatchMailbox.bind(db)
    let scheduled = false
    vi.spyOn(db, 'routeUnreadDirectMessagesToDispatchMailbox').mockImplementation((...args) => {
      const page = route(...args)
      if (page.hasMore && !scheduled) {
        scheduled = true
        setImmediate(() => db.completeDispatch(dispatch.id))
      }
      return page
    })
    const migrate = db.routeUnreadDispatchMailboxToRunMailbox.bind(db)
    const migrationSpy = vi
      .spyOn(db, 'routeUnreadDispatchMailboxToRunMailbox')
      .mockImplementation((...args) => migrate(...args))
    const arrivalSpy = vi.spyOn(harness.runtime, 'notifyMessageArrived')

    const response = await dispatchMailboxCheck(harness.runtime)

    expect(response).toMatchObject({ ok: false, error: { code: 'dispatch_inactive' } })
    expect(db.getUnreadMessages(`dispatch:${dispatch.id}`)).toHaveLength(0)
    expect(migrationSpy).toHaveBeenCalledTimes(4)
    expect(arrivalSpy).toHaveBeenCalledOnce()
    expect(arrivalSpy).toHaveBeenCalledWith(`run:${run.id}`, 'status')
    const plan = sqliteFor(db)
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id, type FROM messages
         INDEXED BY idx_messages_unread_current_inbox
         WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
         ORDER BY sequence LIMIT ?`
      )
      .all(`dispatch:${dispatch.id}`, 51) as { detail: string }[]
    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_messages_unread_current_inbox')
    const coordinator = {
      terminal: SECOND_TERMINAL_HANDLE,
      paneKey: SECOND_PANE_KEY,
      launchToken: SECOND_LAUNCH_TOKEN
    }
    const first = await checkBoundMailbox(harness.runtime, coordinator)
    const second = await ackThenCheck(harness.runtime, first.deliveryId!, coordinator)
    const third = await ackThenCheck(harness.runtime, second.deliveryId!, coordinator)
    const fourth = await ackThenCheck(harness.runtime, third.deliveryId!, coordinator)
    const acknowledged = await checkBoundMailbox(harness.runtime, {
      ...coordinator,
      ack: fourth.deliveryId!
    })
    expect(first.count).toBe(50)
    expect(second.count).toBe(50)
    expect(third.count).toBe(50)
    expect(fourth.count).toBe(1)
    expect(acknowledged).toMatchObject({ count: 0, acknowledged: fourth.deliveryId })
    db.close()
  })

  it('reconciles filtered-out mail when a Dispatch wait loses authority', async () => {
    const db = createDatabase('orca-mailbox-dispatch-wait-fence-')
    const harness = createRuntime(db)
    registerSecondPane(harness.runtime)
    const run = db.createRun({
      objective: 'Dispatch wait fence',
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    const task = db.createTask({ spec: 'Waiting worker', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    const status = insertDirectRunMessage(db, run.id, 'Filtered-out status')
    const controller = new AbortController()
    const waiting = dispatchMailboxCheck(harness.runtime, {
      wait: true,
      types: 'question',
      signal: controller.signal
    })
    const internals = harness.runtime as unknown as {
      messageWaitersByHandle: Map<string, Set<unknown>>
    }
    await vi.waitFor(() => {
      expect(internals.messageWaitersByHandle.has(`dispatch:${dispatch.id}`)).toBe(true)
    })

    db.completeDispatch(dispatch.id)
    controller.abort()
    const response = await waiting

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
    await vi.waitFor(() => {
      expect(db.getUnreadMessages(`dispatch:${dispatch.id}`)).toHaveLength(0)
    })
    const checked = await checkBoundMailbox(harness.runtime, {
      terminal: SECOND_TERMINAL_HANDLE,
      paneKey: SECOND_PANE_KEY,
      launchToken: SECOND_LAUNCH_TOKEN
    })
    expect(checked.messages).toEqual([expect.objectContaining({ id: status.id })])
    const acknowledged = await checkBoundMailbox(harness.runtime, {
      ack: checked.deliveryId!,
      terminal: SECOND_TERMINAL_HANDLE,
      paneKey: SECOND_PANE_KEY,
      launchToken: SECOND_LAUNCH_TOKEN
    })
    expect(acknowledged).toMatchObject({ count: 0, acknowledged: checked.deliveryId })
    db.close()
  })

  it('finishes only the captured inactive-Dispatch snapshot after cancellation', async () => {
    const db = createDatabase('orca-mailbox-dispatch-migration-cancel-')
    const harness = createRuntime(db)
    registerSecondPane(harness.runtime)
    const run = db.createRun({
      objective: 'Dispatch migration cancellation',
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    const task = db.createTask({ spec: 'Cancelled worker check', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    for (let index = 0; index < 151; index += 1) {
      insertDirectRunMessage(db, run.id, `Before cancelled migration ${index}`)
    }
    const route = db.routeUnreadDirectMessagesToDispatchMailbox.bind(db)
    let completed = false
    vi.spyOn(db, 'routeUnreadDirectMessagesToDispatchMailbox').mockImplementation((...args) => {
      const page = route(...args)
      if (page.hasMore && !completed) {
        completed = true
        setImmediate(() => db.completeDispatch(dispatch.id))
      }
      return page
    })
    const controller = new AbortController()
    const migrate = db.routeUnreadDispatchMailboxToRunMailbox.bind(db)
    let cancelled = false
    let postSnapshot: ReturnType<typeof db.insertMessage> | undefined
    const migrationSpy = vi
      .spyOn(db, 'routeUnreadDispatchMailboxToRunMailbox')
      .mockImplementation((...args) => {
        const page = migrate(...args)
        if (page.hasMore && !cancelled) {
          cancelled = true
          postSnapshot = db.insertMessage({
            from: 'term_remote_worker',
            to: `dispatch:${dispatch.id}`,
            subject: 'After cancelled migration snapshot',
            type: 'status',
            runId: run.id
          })
          setImmediate(() => controller.abort())
        }
        return page
      })
    const arrivalSpy = vi.spyOn(harness.runtime, 'notifyMessageArrived')

    const response = await dispatchMailboxCheck(harness.runtime, { signal: controller.signal })

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
    await vi.waitFor(() => {
      expect(migrationSpy).toHaveBeenCalledTimes(4)
    })
    expect(db.getUnreadMessages(`dispatch:${dispatch.id}`)).toEqual([
      expect.objectContaining({ id: postSnapshot?.id })
    ])
    expect(arrivalSpy).toHaveBeenCalledTimes(2)
    expect(arrivalSpy).toHaveBeenNthCalledWith(1, `run:${run.id}`, 'status')
    expect(arrivalSpy).toHaveBeenNthCalledWith(2, `run:${run.id}`, 'status')
    expect(
      sqliteFor(db)
        .prepare('SELECT COUNT(*) AS count FROM messages WHERE to_handle = ?')
        .get(`run:${run.id}`)
    ).toEqual({ count: 151 })
    db.close()
  })

  it('drains current and stored Run handles in one check', async () => {
    const db = createDatabase('orca-mailbox-split-run-handles-')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Split Run handles',
      coordinatorHandle: 'term_previous_coordinator',
      coordinatorPaneKey: PANE_KEY
    })
    const current = insertDirectRunMessage(db, run.id, 'Current handle')
    const previous = db.insertMessage({
      from: 'term_worker',
      to: 'term_previous_coordinator',
      subject: 'Previous handle',
      type: 'status',
      runId: run.id
    })

    const checked = await checkBoundMailbox(harness.runtime)

    expect(checked.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: current.id }),
        expect.objectContaining({ id: previous.id })
      ])
    )
    db.close()
  })

  it('drains current and stored Dispatch handles in one check', async () => {
    const db = createDatabase('orca-mailbox-split-dispatch-handles-')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Split Dispatch handles',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const task = db.createTask({ spec: 'Worker task', runId: run.id })
    createRootDispatch(db, task.id, 'term_previous_worker', PANE_KEY)
    const current = insertDirectRunMessage(db, run.id, 'Current worker handle')
    const previous = db.insertMessage({
      from: 'term_coordinator',
      to: 'term_previous_worker',
      subject: 'Previous worker handle',
      type: 'status',
      runId: run.id
    })

    const checked = await checkBoundMailbox(harness.runtime)

    expect(checked.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: current.id }),
        expect.objectContaining({ id: previous.id })
      ])
    )
    db.close()
  })

  it('routes only the direct-mail snapshot captured when the check starts', async () => {
    const db = createDatabase('orca-mailbox-routing-snapshot-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Routing snapshot')
    for (let index = 0; index < 51; index += 1) {
      insertDirectRunMessage(db, run.id, `Initial ${index}`)
    }
    const route = db.routeUnreadDirectMessagesToRunMailbox.bind(db)
    let inserted = false
    const routeSpy = vi
      .spyOn(db, 'routeUnreadDirectMessagesToRunMailbox')
      .mockImplementation((...args) => {
        const page = route(...args)
        if (page.hasMore && !inserted) {
          inserted = true
          for (let index = 0; index < 60; index += 1) {
            insertDirectRunMessage(db, run.id, `Concurrent ${index}`)
          }
        }
        return page
      })

    await checkBoundMailbox(harness.runtime)

    expect(routeSpy).toHaveBeenCalledTimes(2)
    expect(db.getUnreadMessages(TERMINAL_HANDLE)).toHaveLength(60)
    db.close()
  })
})
