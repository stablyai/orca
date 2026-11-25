import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../../../providers/testing/settled-pty-write-stub'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import {
  createBoundRun,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from '../../orchestration/mailbox/terminal-pointer/orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('mail after an agent exit the hook server proved', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('is not typed into the shell when the agent cleared its title before it quit', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const { runtime } = await createRuntime(db, { launchAgent: 'opencode' })
    const write = vi.fn(() => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'opencode',
      requestRepaint: vi.fn(async () => true)
    })
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, '\x1b]0;OpenCode\x07', 1)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    // OpenCode empties its title while still in front, so the exit's foreground read disproves it.
    runtime.onPtyData(PTY_ID, '\x1b]0;\x07', 2)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.readTerminalMailHold(TERMINAL_HANDLE)).toBeNull()

    runtime.observeWorkerAgentExit(PANE_KEY)
    insertDirectRunMessage(db, createBoundRun(db, 'After exit').id, 'After exit')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(pointerCount(write)).toBe(0)
    db.close()
  })
})
