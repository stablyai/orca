import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import {
  createRuntime,
  createBoundRun,
  driveToLiveIdle,
  insertDirectRunMessage,
  PTY_ID,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

afterEach(() => vi.useRealTimers())

it('keeps a pre-existing Codex draft and unread mail intact after the input hold expires', async () => {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  try {
    const { runtime, write } = await createRuntime(db)
    const run = createBoundRun(db, 'Protect unsent draft')
    await driveToLiveIdle(runtime)
    runtime.onPtyData(
      PTY_ID,
      '\x1b[1m›\x1b[0m My unsent work\x1b7\r\n\r\n\x1b[2mgpt-6 high · /work\x1b[0m\x1b8',
      2
    )
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    expect(runtime.readTerminalMailHold(TERMINAL_HANDLE)).toEqual({ kind: 'draft' })
    vi.setSystemTime(Date.now() + 600_001)
    const message = insertDirectRunMessage(db, run.id, 'Mail behind draft')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    expect(runtime.readTerminalMailHold(TERMINAL_HANDLE)).toEqual({ kind: 'draft' })
    expect(write.mock.calls).toEqual([])
    expect(db.getMessageById(message.id)?.read).toBe(0)
    vi.clearAllTimers()
  } finally {
    db.close()
  }
})
