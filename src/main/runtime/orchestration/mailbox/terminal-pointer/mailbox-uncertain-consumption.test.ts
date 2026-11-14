import { afterEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  PTY_ID,
  registerSecondPane,
  SECOND_PANE_KEY,
  SECOND_TERMINAL_HANDLE,
  sqliteFor,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

it('withdraws the old terminal notice after moved-Run consumption and non-check reads', async () => {
  vi.useFakeTimers()
  const db = createDatabase('orca-uncertain-consumption-')
  const runs = [
    createBoundRun(db, 'Moved Run'),
    createBoundRun(db, 'Settled Run'),
    createBoundRun(db, 'Read Run')
  ]
  const rows = runs.map((run) => {
    const row = insertDirectRunMessage(db, run.id, 'Uncertain mail')
    sqliteFor(db)
      .prepare(
        `UPDATE messages SET to_handle = ?, pointer_enter_pending = 2, pointer_pty_id = ?, pointer_process_incarnation = ? WHERE id = ?`
      )
      .run(`run:${run.id}`, PTY_ID, 'pty-mailbox:mailbox-incarnation', row.id)
    return row
  })
  const { runtime, write } = createRuntime(db)
  try {
    await driveToLiveIdle(runtime)
    await vi.advanceTimersByTimeAsync(1000)
    const retained = () =>
      runtime
        .getMissedNotificationsSince(0, 'reconnected-client')
        .filter(
          (event) =>
            event.type === 'notification' && event.notificationId?.startsWith('orchestration-mail:')
        )
    const initial = retained()
    expect(initial).toHaveLength(1)
    expect(initial[0].type === 'notification' ? initial[0].body : null).toContain(runs[0].id)
    registerSecondPane(runtime)
    const moved = db.bindRun({
      runId: runs[0].id,
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })!
    const batch = db.takeMailboxDelivery({
      runId: moved.id,
      mailboxHandle: `run:${moved.id}`,
      consumerGeneration: moved.consumer_generation
    })
    expect(batch?.messages.map((message) => message.id)).toEqual([rows[0].id])
    await vi.advanceTimersByTimeAsync(0)
    const remaining = retained()
    expect(remaining).toHaveLength(1)
    expect
      .soft(remaining[0].type === 'notification' ? remaining[0].body : null)
      .not.toContain(runs[0].id)
    expect
      .soft(remaining[0].type === 'notification' ? remaining[0].body : null)
      .toContain(runs[1].id)
    db.markAsReadAndDelivered([rows[1].id])
    db.markAsRead([rows[2].id])
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(retained()).toEqual([])
    expect(
      runtime
        .getMissedNotificationsSince(0, 'reconnected-client')
        .filter(
          (event) =>
            event.type === 'notification' && event.notificationId?.startsWith('orchestration-mail:')
        )
    ).toEqual([])
    await vi.advanceTimersByTimeAsync(600000)
    expect(write).not.toHaveBeenCalled()
    for (const row of rows) {
      expect(db.getMessageById(row.id)).toMatchObject({ read: 1, pointer_enter_pending: 0 })
    }
  } finally {
    db.close()
  }
})
