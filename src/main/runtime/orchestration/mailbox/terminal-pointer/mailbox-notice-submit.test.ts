import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  isMailboxPointer,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { reportHeldMailNotice } from '../../workers/turn-stops/held-mail-notice-report'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))
vi.mock('../../workers/turn-stops/held-mail-notice-report', () => ({
  reportHeldMailNotice: vi.fn(async () => {})
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** An idle Codex that echoes a typed notice into its composer (plus `userText`) and empties the
 *  composer on the `takesEnter`th Enter; Windows Codex can keep earlier Enters as newlines. */
async function deliverToCodex(options: {
  takesEnter: number
  /** The screen can't be read once the notice is typed. */
  unreadable?: true
  userText?: string
  /** Mail that arrives while the first notice's Enter is checked, and after. */
  moreMail?: true
}) {
  vi.useFakeTimers()
  const db = createDatabase('orca-notice-submit-')
  const { runtime, write } = await createRuntime(db)
  // Orca started this process, so its own typed notice is not a person's draft.
  runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID, incarnationId: 'mailbox-incarnation' })
  let sequence = 10
  const paint = (draft: string) =>
    runtime.onPtyData(
      PTY_ID,
      `\x1b[H\x1b[2J\x1b[1m›\x1b[0m ${draft}\x1b7\r\n\r\n  gpt-5.4 high · ~/repo\x1b8`,
      sequence++
    )
  let enters = 0
  let unreadable: { mockRestore: () => void } | undefined
  write.mockImplementation((_ptyId: string, data: string) => {
    if (isMailboxPointer(data)) {
      paint(`${data.trim()}${options.userText ?? ''}`)
    } else if (data === '\r' && ++enters === options.takesEnter) {
      paint('')
    }
    return true
  })
  try {
    await driveToLiveIdle(runtime)
    if (options.unreadable) {
      // The prototype method every composer read goes through.
      unreadable = vi
        .spyOn(Object.getPrototypeOf(runtime), 'readCurrentTerminalWaitScreen')
        .mockResolvedValue(null)
    }
    const run = createBoundRun(db, 'Notice submit')
    insertDirectRunMessage(db, run.id, 'Mail')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    if (options.moreMail) {
      await vi.advanceTimersByTimeAsync(1_000)
      insertDirectRunMessage(db, run.id, 'Mid-flight mail')
      runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
      await vi.advanceTimersByTimeAsync(10_000)
      insertDirectRunMessage(db, run.id, 'Later mail')
      runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    return {
      pointers: pointerCount(write),
      enters,
      reported: vi.mocked(reportHeldMailNotice).mock.calls.length
    }
  } finally {
    unreadable?.mockRestore()
    db.close()
  }
}

it('presses no second Enter once the first one took the notice', async () => {
  expect(await deliverToCodex({ takesEnter: 1 })).toEqual({ pointers: 1, enters: 1, reported: 0 })
})

it('presses Enter once more while the composer still holds exactly the notice', async () => {
  expect(await deliverToCodex({ takesEnter: 2 })).toEqual({ pointers: 1, enters: 2, reported: 0 })
})

it('tells the coordinator when the notice is still held after the retry', async () => {
  expect(await deliverToCodex({ takesEnter: 0 })).toEqual({ pointers: 1, enters: 2, reported: 1 })
})

it('never presses Enter over text that is not exactly the notice', async () => {
  expect(await deliverToCodex({ takesEnter: 0, userText: ' and my own words' })).toEqual({
    pointers: 1,
    enters: 1,
    reported: 0
  })
})

it('types no later notice over one still held in the composer', async () => {
  expect(await deliverToCodex({ takesEnter: 0, moreMail: true })).toEqual({
    pointers: 1,
    enters: 2,
    reported: 1
  })
})

it('tells the coordinator when the screen cannot be read after the Enter', async () => {
  expect(await deliverToCodex({ takesEnter: 1, unreadable: true })).toEqual({
    pointers: 1,
    enters: 1,
    reported: 1
  })
})
