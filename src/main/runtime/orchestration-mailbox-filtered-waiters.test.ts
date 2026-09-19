import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
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

describe('orchestration mailbox filtered waiters', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
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

    const checked = await checkBoundMailbox(harness.runtime, { wait: true, types: 'question' })
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

    const checked = await checkBoundMailbox(harness.runtime, { wait: true, types: 'question' })
    expect(checked).toMatchObject({ runId: run.id, dispatchId: dispatch.id, count: 50 })
    expect(checked.messages).not.toContainEqual(expect.objectContaining({ id: question.id }))
    expect(db.getMessageById(question.id)?.to_handle).toBe(`dispatch:${dispatch.id}`)
    const next = await checkBoundMailbox(harness.runtime, {
      ack: checked.deliveryId!,
      types: 'question'
    })
    expect(next.messages).toEqual([expect.objectContaining({ id: question.id })])
    db.close()
  })
})
