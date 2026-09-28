import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  pointerCount,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('orchestration silent mailbox notification', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never injects silent mail on idle but still notifies normal mail in the same mailbox', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-no-notify-')
    try {
      const { runtime, write } = createRuntime(db)
      const run = createBoundRun(db, 'External transport')
      const mailbox = `run:${run.id}`
      const silent = db.insertMessage({
        from: 'worker',
        to: mailbox,
        runId: run.id,
        subject: 'external',
        notify: false
      })
      runtime.notifyMessageArrived(mailbox, 'status')
      await driveToLiveIdle(runtime)
      await vi.advanceTimersByTimeAsync(500)
      expect(pointerCount(write)).toBe(0)
      const normal = db.insertMessage({
        from: 'worker',
        to: mailbox,
        runId: run.id,
        subject: 'native'
      })
      runtime.notifyMessageArrived(mailbox, 'status')
      await vi.advanceTimersByTimeAsync(500)
      expect(pointerCount(write)).toBe(1)
      expect(db.getMessageById(silent.id)).toMatchObject({ notify: 0, delivered_at: null, read: 0 })
      expect(db.getMessageById(normal.id)?.delivered_at).not.toBeNull()
    } finally {
      db.close()
    }
  })
})
