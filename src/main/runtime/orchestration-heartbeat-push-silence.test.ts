import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type OrchestrationDb } from './orchestration/db'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  pointerCount,
  sqliteFor,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const REJECTION_PAYLOAD = JSON.stringify({
  _orcaLifecycleRejection: { code: 'sender_not_assignee', reason: 'invalid sender' }
})

function insertRunMessage(
  db: OrchestrationDb,
  runId: string,
  subject: string,
  type: 'heartbeat' | 'worker_done',
  payload?: string
): void {
  const message = db.insertMessage({
    from: 'term_worker',
    to: TERMINAL_HANDLE,
    subject,
    type,
    runId,
    payload,
    deliveryContract: 'current_delivery'
  })
  sqliteFor(db)
    .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
    .run(TERMINAL_HANDLE, message.id)
}

describe('orchestration heartbeat push silence', () => {
  let db: OrchestrationDb | undefined

  function openRun(objective: string) {
    db = createDatabase('orca-heartbeat-silence-')
    return { db, run: createBoundRun(db, objective), ...createRuntime(db) }
  }

  afterEach(async () => {
    vi.useRealTimers()
    // Why: mailbox routing defers work to setImmediate, so closing the database in the same tick
    // leaves those callbacks to run against a closed handle and reject with ERR_INVALID_STATE.
    // Drain one immediate turn first; a backlog of messages schedules more of them than a single
    // test used to.
    await new Promise((resolve) => setImmediate(resolve))
    // Why: close before the rmSync — a failed assertion skips any per-test close, and on Windows
    // an open SQLite handle turns cleanup into an EPERM that buries the assertion that actually failed.
    db?.close()
    db = undefined
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never points an idle coordinator at a valid heartbeat', async () => {
    const { db, run, runtime, write } = openRun('heartbeat silence')
    insertRunMessage(db, run.id, 'alive', 'heartbeat')

    await driveToLiveIdle(runtime)
    runtime.notifyMessageArrived(TERMINAL_HANDLE, 'heartbeat')
    await Promise.resolve()

    expect(pointerCount(write)).toBe(0)
  })

  it('still lists the silent heartbeat on an explicit check', async () => {
    const { db, run, runtime, write } = openRun('heartbeat audit')
    insertRunMessage(db, run.id, 'alive', 'heartbeat')

    await driveToLiveIdle(runtime)
    runtime.notifyMessageArrived(TERMINAL_HANDLE, 'heartbeat')
    await Promise.resolve()
    const checked = await checkBoundMailbox(runtime)

    // Why: the row stays unread, so suppressing the wake never hides the heartbeat itself.
    expect(pointerCount(write)).toBe(0)
    expect(checked.count).toBe(1)
  })

  it('points at a rejected heartbeat, which reports a refused claim rather than liveness', async () => {
    const { db, run, runtime, write } = openRun('heartbeat rejection')
    insertRunMessage(db, run.id, 'Rejected heartbeat', 'heartbeat', REJECTION_PAYLOAD)

    await driveToLiveIdle(runtime)
    runtime.notifyMessageArrived(TERMINAL_HANDLE, 'heartbeat')
    await Promise.resolve()

    expect(pointerCount(write)).toBeGreaterThan(0)
  })

  it('still points a worker_done queued behind a full page of silent heartbeats', async () => {
    const { db, run, runtime, write } = openRun('heartbeat backlog')
    // Why: heartbeats are never delivered and stay unread, so they pile up at the head of the
    // queue. Filtering them after the delivery LIMIT eventually leaves an empty page and the push
    // starves — six lanes at the preamble's cadence reach this in well under an hour.
    for (let index = 0; index < ORCHESTRATION_DELIVERY_BATCH_LIMIT + 5; index++) {
      insertRunMessage(db, run.id, `alive ${index}`, 'heartbeat')
    }
    insertRunMessage(db, run.id, 'work complete', 'worker_done')

    await driveToLiveIdle(runtime)
    runtime.notifyMessageArrived(TERMINAL_HANDLE, 'worker_done')
    await Promise.resolve()

    expect(pointerCount(write)).toBeGreaterThan(0)
  })

  it('does not let a queued heartbeat suppress the push a later worker_done earns', async () => {
    const { db, run, runtime, write } = openRun('heartbeat then done')
    insertRunMessage(db, run.id, 'alive', 'heartbeat')
    insertRunMessage(db, run.id, 'work complete', 'worker_done')

    await driveToLiveIdle(runtime)
    runtime.notifyMessageArrived(TERMINAL_HANDLE, 'worker_done')
    await Promise.resolve()

    expect(pointerCount(write)).toBeGreaterThan(0)
  })
})
