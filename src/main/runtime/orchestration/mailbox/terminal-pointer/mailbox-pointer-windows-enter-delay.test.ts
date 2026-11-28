import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

const host = vi.hoisted((): { platform: NodeJS.Platform } => ({ platform: 'darwin' }))

vi.mock('../../../terminal/input/pty-write-host-platform', () => ({
  resolvePtyWriteHostPlatform: () => host.platform
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

/** Ms from the notice's write to its Enter, and the notice's length, for an idle Codex on a `platform` host. */
async function noticeEnterDelay(
  platform: NodeJS.Platform
): Promise<{ waitedMs: number; noticeChars: number }> {
  host.platform = platform
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const { runtime, write } = await createRuntime(db)
  await driveToLiveIdle(runtime)
  insertDirectRunMessage(db, createBoundRun(db, 'Enter delay Run').id, 'Reply')
  runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
  await vi.advanceTimersByTimeAsync(0)
  expect(pointerCount(write)).toBe(1)
  let waitedMs = 0
  while (!write.mock.calls.some(([, payload]) => payload === '\r') && waitedMs < 10_000) {
    await vi.advanceTimersByTimeAsync(10)
    waitedMs += 10
  }
  db.close()
  return { waitedMs, noticeChars: String(write.mock.calls[0]?.[1]).length }
}

// Windows Codex reads a typed notice a key at a time and keeps an Enter sent mid-read as a newline.
describe('mailbox notice Enter delay', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps 500 ms off Windows and waits out the key-by-key read on a Windows host', async () => {
    expect((await noticeEnterDelay('darwin')).waitedMs).toBe(500)
    expect((await noticeEnterDelay('linux')).waitedMs).toBe(500)
    const windows = await noticeEnterDelay('win32')
    // At least the 500 ms settle plus 3 ms per key event Codex reads.
    expect(windows.waitedMs).toBeGreaterThanOrEqual(500 + 3 * windows.noticeChars)
    expect(windows.waitedMs).toBeLessThan(10_000)
  })
})
