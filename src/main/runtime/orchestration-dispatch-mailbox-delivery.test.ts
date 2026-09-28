import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createRuntime,
  driveToLiveIdle,
  PANE_KEY,
  PTY_ID,
  pointerCount,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './orchestration/db/messages/mailbox-pointer-enter-state'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('Dispatch mailbox Delivery', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('wakes once, replays after restart, and leaves concurrent guidance for the next ack', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-dispatch-delivery-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = createRuntime(firstDb)
    const run = firstDb.createRun({
      objective: 'Dispatch mailbox',
      coordinatorHandle: 'term_dispatch_coordinator',
      coordinatorPaneKey:
        '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
    })
    const task = firstDb.createTask({ spec: 'Wait for guidance', runId: run.id })
    const dispatch = createRootDispatch(
      firstDb,
      task.id,
      TERMINAL_HANDLE,
      PANE_KEY,
      undefined,
      'pty-mailbox:mailbox-incarnation'
    )
    const address = `dispatch:${dispatch.id}`
    const firstMessage = firstDb.insertMessage({
      from: run.coordinator_handle!,
      to: address,
      subject: 'First follow-up',
      runId: run.id
    })

    await driveToLiveIdle(first.runtime)
    first.runtime.notifyMessageArrived(address, 'status')
    first.runtime.notifyMessageArrived(address, 'status')
    await Promise.resolve()
    expect(pointerCount(first.write)).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(first.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)

    const issued = await checkBoundMailbox(first.runtime)
    expect(issued).toMatchObject({ dispatchId: dispatch.id, count: 1, replayed: false })
    expect(issued.messages).toEqual([expect.objectContaining({ id: firstMessage.id })])
    expect(firstDb.getWorkerAttentionFacts(dispatch.id, Date.now()).pendingGuidance).toBe(true)
    firstDb.insertMessage({
      from: run.coordinator_handle!,
      to: address,
      subject: 'Concurrent follow-up',
      runId: run.id
    })
    firstDb.close()

    const restartedDb = new OrchestrationDb(dbPath)
    const restarted = createRuntime(restartedDb)
    await driveToLiveIdle(restarted.runtime)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(pointerCount(restarted.write)).toBe(0)

    const replayed = await checkBoundMailbox(restarted.runtime)
    expect(replayed).toMatchObject({
      dispatchId: dispatch.id,
      deliveryId: issued.deliveryId,
      count: 1,
      replayed: true
    })
    const next = await checkBoundMailbox(restarted.runtime, { ack: replayed.deliveryId! })
    expect(next.messages).toEqual([expect.objectContaining({ subject: 'Concurrent follow-up' })])
    expect(restartedDb.getMessageById(firstMessage.id)?.read).toBe(1)
    expect(restartedDb.getWorkerAttentionFacts(dispatch.id, Date.now()).pendingGuidance).toBe(true)

    await checkBoundMailbox(restarted.runtime, { ack: next.deliveryId! })
    expect(restartedDb.getWorkerAttentionFacts(dispatch.id, Date.now()).pendingGuidance).toBe(false)
    restartedDb.close()
  })

  it.each([
    ['pointer write', MAILBOX_POINTER_WRITE_ATTEMPTED],
    ['pointer Enter', MAILBOX_POINTER_ENTER_ATTEMPTED]
  ])(
    'keeps unread attention after an ambiguous %s crash without resubmitting',
    async (_, phase) => {
      vi.useFakeTimers()
      const directory = mkdtempSync(join(tmpdir(), 'orca-dispatch-ambiguous-pointer-'))
      temporaryDirectories.push(directory)
      const dbPath = join(directory, 'orchestration.db')
      const firstDb = new OrchestrationDb(dbPath)
      const run = firstDb.createRun({
        objective: 'Ambiguous Dispatch pointer',
        coordinatorHandle: 'term_dispatch_coordinator',
        coordinatorPaneKey:
          '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
      })
      const task = firstDb.createTask({ spec: 'Read ambiguous guidance', runId: run.id })
      const processIncarnation = `${PTY_ID}:mailbox-incarnation`
      const dispatch = createRootDispatch(
        firstDb,
        task.id,
        TERMINAL_HANDLE,
        PANE_KEY,
        undefined,
        processIncarnation
      )
      const message = firstDb.insertMessage({
        from: run.coordinator_handle!,
        to: `dispatch:${dispatch.id}`,
        subject: 'Ambiguous guidance',
        runId: run.id
      })
      const target = { ptyId: PTY_ID, processIncarnation }
      expect(firstDb.stageMailboxPointerEnter([message.id], target)).toBe(true)
      expect(firstDb.markMailboxPointerWriteAttempted([message.id], target)).toBe(true)
      if (phase === MAILBOX_POINTER_ENTER_ATTEMPTED) {
        expect(firstDb.markMailboxPointerEnterAttempted([message.id], target)).toBe(true)
      }
      firstDb.close()

      const restartedDb = new OrchestrationDb(dbPath)
      const restarted = createRuntime(restartedDb)
      await driveToLiveIdle(restarted.runtime)
      await vi.advanceTimersByTimeAsync(500)

      expect(pointerCount(restarted.write)).toBe(0)
      expect(restarted.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
      expect(restartedDb.getWorkerAttentionFacts(dispatch.id, Date.now()).pendingGuidance).toBe(
        true
      )
      const delivery = await checkBoundMailbox(restarted.runtime)
      expect(delivery.messages).toEqual([expect.objectContaining({ id: message.id })])
      expect(restartedDb.getWorkerAttentionFacts(dispatch.id, Date.now()).pendingGuidance).toBe(
        true
      )
      await checkBoundMailbox(restarted.runtime, { ack: delivery.deliveryId! })
      expect(restartedDb.getWorkerAttentionFacts(dispatch.id, Date.now()).pendingGuidance).toBe(
        false
      )
      expect(restartedDb.getMessageById(message.id)).toMatchObject({
        read: 1,
        pointer_enter_pending: 0,
        pointer_pty_id: null,
        pointer_process_incarnation: null
      })
      restartedDb.close()
    }
  )

  it('keeps an active worker Delivery stable when the coordinator Run is rebound', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Rebound coordinator',
      coordinatorHandle: 'term_old_coordinator',
      coordinatorPaneKey: 'tab_old:leaf_old'
    })
    const task = db.createTask({ spec: 'Keep worker mail', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    db.insertMessage({
      from: run.coordinator_handle!,
      to: `dispatch:${dispatch.id}`,
      subject: 'Stable guidance',
      runId: run.id
    })
    const delivery = db.getOrCreateMailboxDelivery({
      runId: run.id,
      mailboxHandle: `dispatch:${dispatch.id}`,
      consumerGeneration: 0
    })!

    db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_new_coordinator',
      coordinatorPaneKey: 'tab_new:leaf_new'
    })

    expect(db.getDeliveryRaw(delivery.delivery.id)?.status).toBe('outstanding')
    expect(
      db.getOrCreateMailboxDelivery({
        runId: run.id,
        mailboxHandle: `dispatch:${dispatch.id}`,
        consumerGeneration: 0
      })?.delivery.id
    ).toBe(delivery.delivery.id)
    db.close()
  })
})
