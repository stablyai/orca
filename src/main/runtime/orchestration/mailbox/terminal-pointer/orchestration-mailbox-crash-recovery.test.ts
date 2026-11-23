import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { checkBoundMailbox } from './orchestration-mailbox-check.test-fixture'

import { OrchestrationDb } from '../../db/orchestration-db'
import { agentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { MAILBOX_POINTER_ENTER_ATTEMPTED } from '../../db/messages/mailbox-pointer-enter-state'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const CLAUDE_COMPOSER = '\x1b[?2031h\x1b[?2004h│ ❯  │\x1b[?25h'

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

describe('orchestration mailbox crash recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not replay Enter when Enter was accepted before settlement', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-enter-crash-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = await createRuntime(firstDb)
    const run = createBoundRun(firstDb, 'Enter crash Run')
    const message = insertDirectRunMessage(firstDb, run.id, 'Visible before Enter crash')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's write mock takes (ptyId, payload).
    const recordWrite = first.write as unknown as (id: string, payload: string) => unknown
    const write = vi.fn((ptyId: string, data: string) => {
      recordWrite(ptyId, data)
      if (data === '\r') {
        firstDb.close()
      }
      return true
    })
    first.runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })

    await driveToLiveIdle(first.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(first.write)).toBe(1)
    expect(first.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)

    const restartedDb = new OrchestrationDb(dbPath)
    expect(restartedDb.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_ENTER_ATTEMPTED
    })
    const restarted = await createRuntime(restartedDb)
    await driveToLiveIdle(restarted.runtime)
    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(restarted.runtime)

    expect(pointerCount(restarted.write)).toBe(0)
    expect(restarted.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    restartedDb.close()
  })

  it('asks again on the next recheck when no host was asked, then delivers on the paint', async () => {
    const { db, runtime, write, requestRepaint } = await reattachedIdleClaude()
    // A phone owned the grid (or the host could not be reached) at the first ask.
    requestRepaint.mockResolvedValueOnce(false)
    const run = createBoundRun(db, 'Reattached Run')
    const message = insertDirectRunMessage(db, run.id, 'After restart')

    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    expect(requestRepaint).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestRepaint).toHaveBeenCalledTimes(2)
    expect(pointerCount(write)).toBe(0)

    // The second ask reached the host: later rechecks ask nothing more.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestRepaint).toHaveBeenCalledTimes(2)

    runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER, 2)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pointerCount(write)).toBe(1)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    db.close()
  })
})
