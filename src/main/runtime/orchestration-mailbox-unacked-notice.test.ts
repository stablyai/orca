import './rpc/unused-default-rpc-methods.test-fixture'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import {
  WRITE_ACCEPTED,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import {
  MAILBOX_POINTER_WRITE_ATTEMPTED,
  MAILBOX_POINTER_ENTER_ATTEMPTED
} from './orchestration/db/messages/mailbox-pointer-enter-state'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

function workerMailbox() {
  const db = createDatabase('orca-unacked-worker-notice-')
  const harness = createRuntime(db)
  const run = db.createRun({
    objective: 'Continue hearing coordinator guidance',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
  })
  const task = db.createTask({ spec: 'Read guidance', runId: run.id })
  const dispatch = createRootDispatch(
    db,
    task.id,
    TERMINAL_HANDLE,
    PANE_KEY,
    undefined,
    `${PTY_ID}:mailbox-incarnation`
  )
  const mailbox = `dispatch:${dispatch.id}`
  const receive = (subject: string) => {
    const message = db.insertMessage({
      from: 'term_coordinator',
      to: mailbox,
      subject,
      runId: run.id
    })
    harness.runtime.notifyMessageArrived(mailbox, 'status')
    return message
  }
  return { db, ...harness, mailbox, receive }
}

describe('terminal worker notices after a check without acknowledgement', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('notices new mail on the only idle edge after an in-flight Enter loses settlement', async () => {
    vi.useFakeTimers()
    const { db, runtime, mailbox, receive } = workerMailbox()
    const write = vi.fn((_ptyId: string, _data: string) => true)
    let settleEnter: ((settlement: WriteSettlement) => void) | undefined
    runtime.setPtyController({
      write,
      writeWithSettlement: (ptyId, data) => {
        write(ptyId, data)
        if (data === '\r' && !settleEnter) {
          return new Promise<WriteSettlement>((resolve) => {
            settleEnter = resolve
          })
        }
        return WRITE_ACCEPTED
      },
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    try {
      await driveToLiveIdle(runtime)
      const first = receive('Fetched guidance with lost Enter settlement')
      await vi.advanceTimersByTimeAsync(500)
      expect(pointerCount(write)).toBe(1)
      expect(settleEnter).toEqual(expect.any(Function))
      await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex working\x07', 3).completion
      settleEnter?.(writeUnverifiable('transport_settlement_lost', true))
      await vi.advanceTimersByTimeAsync(0)
      expect(db.getMessageById(first.id)?.pointer_enter_pending).toBe(
        MAILBOX_POINTER_ENTER_ATTEMPTED
      )
      const checked = await checkBoundMailbox(runtime)
      expect(checked.messages).toEqual([expect.objectContaining({ id: first.id })])
      const newer = receive('New guidance while the worker is busy')
      await vi.advanceTimersByTimeAsync(500)
      expect(pointerCount(write)).toBe(1)
      await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex done\x07', 4).completion
      await vi.advanceTimersByTimeAsync(500)
      expect(pointerCount(write)).toBe(2)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(2)
      expect(db.getMessageById(newer.id)?.delivered_at).toEqual(expect.any(String))
      expect(db.getMessageById(first.id)?.pointer_enter_pending).toBe(0)
      expect((await checkBoundMailbox(runtime)).deliveryId).toBe(checked.deliveryId)
      expect(db.hasOutstandingMailboxDelivery(mailbox)).toBe(true)
    } finally {
      db.close()
    }
  })

  it.each([MAILBOX_POINTER_WRITE_ATTEMPTED, MAILBOX_POINTER_ENTER_ATTEMPTED])(
    'checks newer attention on the same idle edge that settles recovered phase %s',
    async (phase) => {
      vi.useFakeTimers()
      const { db, runtime, receive } = workerMailbox()
      try {
        await driveToLiveIdle(runtime)
        receive('Fetched guidance')
        await vi.advanceTimersByTimeAsync(500)
        const checked = await checkBoundMailbox(runtime)
        await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex working\x07', 3).completion
        const uncertain = receive('Notice handed off before restart')
        const target = { ptyId: PTY_ID, processIncarnation: `${PTY_ID}:mailbox-incarnation` }
        expect(db.stageMailboxPointerEnter([uncertain.id], target)).toBe(true)
        expect(db.markMailboxPointerWriteAttempted([uncertain.id], target)).toBe(true)
        if (phase === MAILBOX_POINTER_ENTER_ATTEMPTED) {
          expect(db.markMailboxPointerEnterAttempted([uncertain.id], target)).toBe(true)
        }
        const newer = receive('Newer guidance before the only idle edge')
        const restarted = createRuntime(db)
        await restarted.runtime.listTerminals()
        await restarted.runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex done\x07', 1).completion
        await vi.advanceTimersByTimeAsync(500)
        expect(pointerCount(restarted.write)).toBe(1)
        expect(restarted.write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
        expect(db.getMessageById(newer.id)?.delivered_at).toEqual(expect.any(String))
        expect(db.getMessageById(uncertain.id)).toMatchObject({
          pointer_enter_pending: 0,
          delivered_at: expect.any(String)
        })
        expect((await checkBoundMailbox(restarted.runtime)).deliveryId).toBe(checked.deliveryId)
      } finally {
        db.close()
      }
    }
  )

  it.each(['before new mail', 'after new mail'])(
    'notifies later guidance when the consumer goes idle %s',
    async (idleTiming) => {
      vi.useFakeTimers()
      const { db, runtime, write, mailbox, receive } = workerMailbox()
      try {
        await driveToLiveIdle(runtime)
        const first = receive('First guidance')
        await vi.advanceTimersByTimeAsync(500)
        expect(pointerCount(write)).toBe(1)
        const checked = await checkBoundMailbox(runtime)
        expect(checked.messages).toEqual([expect.objectContaining({ id: first.id })])
        expect(db.hasOutstandingMailboxDelivery(mailbox)).toBe(true)

        await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex working\x07', 3).completion
        if (idleTiming === 'before new mail') {
          await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex done\x07', 4).completion
        }
        const later = receive('Later guidance')
        await vi.advanceTimersByTimeAsync(500)
        if (idleTiming === 'after new mail') {
          expect(pointerCount(write)).toBe(1)
          await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex done\x07', 4).completion
          await vi.advanceTimersByTimeAsync(500)
        }
        expect(pointerCount(write)).toBe(2)
        expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(2)
        expect(db.getMessageById(later.id)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String)
        })

        runtime.notifyMessageArrived(mailbox, 'status')
        runtime.deliverPendingMessagesForHandle(mailbox)
        await vi.advanceTimersByTimeAsync(500)
        expect(pointerCount(write)).toBe(2)
        const replayed = await checkBoundMailbox(runtime)
        expect(replayed.deliveryId).toBe(checked.deliveryId)
        expect(replayed.messages).toEqual([expect.objectContaining({ id: first.id })])
        const next = await checkBoundMailbox(runtime, { ack: checked.deliveryId ?? undefined })
        expect(next.messages).toEqual([expect.objectContaining({ id: later.id })])
      } finally {
        db.close()
      }
    }
  )
})
