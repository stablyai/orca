import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { agentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import {
  createBoundRun,
  createRuntime,
  insertDirectRunMessage,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const CLAUDE_COMPOSER = '\x1b[?2031h\x1b[?2004h│ ❯  │\x1b[?25h'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function reattachedIdleClaude() {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const harness = await createRuntime(db, { launchAgent: 'claude', foregroundProcess: 'claude' })
  const { runtime } = harness
  await runtime.listTerminals()
  // A restart reattached this idle process: its composer was drawn before Orca started, and its
  // status comes back from its last hook report.
  vi.spyOn(agentHookServer, 'readRestoredAgentStatus').mockResolvedValue({ state: 'done' })
  runtime.startReattachedOutputClock(PTY_ID)
  runtime.restoreReattachedAgentStatus(PTY_ID)
  await vi.advanceTimersByTimeAsync(0)
  await runtime.serializeMainTerminalBuffer(PTY_ID)
  return { db, ...harness }
}

it('asks a reattached idle agent to repaint once, then delivers the mail it held', async () => {
  const { db, runtime, write, requestRepaint } = await reattachedIdleClaude()
  const run = createBoundRun(db, 'Reattached Run')
  const message = insertDirectRunMessage(db, run.id, 'After restart')

  runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
  expect(pointerCount(write)).toBe(0)
  expect(requestRepaint).toHaveBeenCalledTimes(1)
  expect(requestRepaint).toHaveBeenCalledWith(PTY_ID)

  // Rechecks while the repaint is in flight ask nothing more.
  await vi.advanceTimersByTimeAsync(10_000)
  expect(requestRepaint).toHaveBeenCalledTimes(1)
  expect(pointerCount(write)).toBe(0)

  runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER, 2)
  await runtime.serializeMainTerminalBuffer(PTY_ID)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(pointerCount(write)).toBe(1)
  expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
  expect(requestRepaint).toHaveBeenCalledTimes(1)
  db.close()
})
