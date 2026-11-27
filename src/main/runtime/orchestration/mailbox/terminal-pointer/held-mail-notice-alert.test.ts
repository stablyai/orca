import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  isMailboxPointer,
  PANE_KEY,
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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const HELD_SUBJECT = "Worker's mailbox notice may not have been submitted"

/** A terminal Codex worker whose composer keeps every notice: its Enters never take. */
async function heldNoticeWorker(options: { closeDispatchDuringScreenRead: boolean }) {
  vi.useFakeTimers()
  const db = createDatabase('orca-held-notice-alert-')
  const { runtime, write } = await createRuntime(db)
  const run = db.createRun({
    objective: 'work',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: null
  })
  const task = db.createTask({ runId: run.id, spec: 'work' })
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: TERMINAL_HANDLE,
    assigneePaneKey: PANE_KEY,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  let sequence = 10
  write.mockImplementation((_ptyId: string, data: string) => {
    if (isMailboxPointer(data)) {
      runtime.onPtyData(
        PTY_ID,
        `\x1b[H\x1b[2J\x1b[1m›\x1b[0m ${data.trim()}\x1b7\r\n\r\n  gpt-5.4 high · ~/repo\x1b8`,
        sequence++
      )
    }
    return true
  })
  const readTerminal = runtime.readTerminal.bind(runtime)
  vi.spyOn(runtime, 'readTerminal').mockImplementation(async (...args) => {
    if (options.closeDispatchDuringScreenRead) {
      // The worker reported done while Orca read its screen for the alert.
      db.db
        .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
        .run(dispatch.id)
    }
    return readTerminal(...args)
  })
  try {
    await driveToLiveIdle(runtime)
    db.insertMessage({
      from: 'term_coordinator',
      to: `dispatch:${dispatch.id}`,
      subject: 'Follow-up',
      type: 'status',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(10_000)
    return db.db.prepare('SELECT subject FROM messages WHERE subject = ?').all(HELD_SUBJECT).length
  } finally {
    db.close()
  }
}

it('tells the coordinator when a worker leaves a mailbox notice in its prompt', async () => {
  expect(await heldNoticeWorker({ closeDispatchDuringScreenRead: false })).toBe(1)
})

it('tells no one once the Dispatch closed while the screen was read', async () => {
  expect(await heldNoticeWorker({ closeDispatchDuringScreenRead: true })).toBe(0)
})
