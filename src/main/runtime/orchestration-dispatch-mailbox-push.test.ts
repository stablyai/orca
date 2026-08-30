import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  LAUNCH_TOKEN,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const COORDINATOR_PANE_KEY =
  '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'

function dispatchToWorker(db: OrchestrationTestDb) {
  const run = db.createRun({
    objective: 'Coordinator run',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: COORDINATOR_PANE_KEY
  })
  const task = db.createTask({ spec: 'Worker task', runId: run.id })
  return { run, dispatch: db.createDispatchContext(task.id, TERMINAL_HANDLE, PANE_KEY) }
}

type OrchestrationTestDb = ReturnType<typeof createDatabase>

function sendToDispatch(
  db: OrchestrationTestDb,
  runId: string,
  dispatchId: string,
  subject: string
) {
  return db.insertMessage({
    from: 'term_coordinator',
    to: `dispatch:${dispatchId}`,
    subject,
    type: 'status',
    runId,
    deliveryContract: 'current_delivery'
  })
}

describe('dispatch mailbox push-on-idle', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('points an idle worker at mail already waiting in its Dispatch mailbox', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-dispatch-push-idle-')
    const harness = createRuntime(db)
    const { run, dispatch } = dispatchToWorker(db)
    sendToDispatch(db, run.id, dispatch.id, 'push authorization')

    await driveToLiveIdle(harness.runtime)
    await vi.advanceTimersByTimeAsync(600)

    expect(pointerCount(harness.write)).toBe(1)
    // A Dispatch pointer carries no --run flag: the bare command is what resolves
    // the caller's own Dispatch mailbox, so pinning it to a Run would misdirect the worker.
    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      '\nYou have 1 orchestration message. Run `orca orchestration check`.\n'
    )
    // The pointer must be backed by mail the worker's own check then returns.
    await expect(
      checkBoundMailbox(harness.runtime, {
        terminal: TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: LAUNCH_TOKEN
      })
    ).resolves.toMatchObject({ dispatchId: dispatch.id, count: 1 })
    db.close()
  })

  it('points a worker that is already idle when Dispatch mail arrives', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-dispatch-push-arrival-')
    const harness = createRuntime(db)
    const { run, dispatch } = dispatchToWorker(db)

    await driveToLiveIdle(harness.runtime)
    sendToDispatch(db, run.id, dispatch.id, 'rule update')
    harness.runtime.notifyMessageArrived(`dispatch:${dispatch.id}`, 'status')
    await vi.advanceTimersByTimeAsync(600)

    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })

  it('holds Dispatch mail for a busy worker until it returns to idle', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-dispatch-push-busy-')
    const harness = createRuntime(db)
    const { run, dispatch } = dispatchToWorker(db)

    await harness.runtime.listTerminals()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
    sendToDispatch(db, run.id, dispatch.id, 'urgent rule update')
    harness.runtime.notifyMessageArrived(`dispatch:${dispatch.id}`, 'status')
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(harness.write)).toBe(0)

    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 2)
    await vi.advanceTimersByTimeAsync(600)

    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })

  it('repoints Dispatch mail left unread when the database attaches', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-dispatch-push-restore-')
    const harness = createRuntime(db)
    const { run, dispatch } = dispatchToWorker(db)

    await driveToLiveIdle(harness.runtime)
    // Mail that landed while the app was down raises no arrival notification.
    sendToDispatch(db, run.id, dispatch.id, 'offline rule update')
    harness.runtime.setOrchestrationDb(db)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })

  it('releases only the push stamp of the mailbox that staged it', () => {
    const db = createDatabase('orca-dispatch-push-release-')
    const { run, dispatch } = dispatchToWorker(db)
    const message = sendToDispatch(db, run.id, dispatch.id, 'push authorization')
    db.markAsDelivered([message.id])

    // The mail moves to the Run mailbox and the coordinator is pointed at it.
    db.routeUnreadDispatchMailboxToRunMailbox(dispatch.id, run.id)
    db.markAsDelivered([message.id])
    // Only now does the worker's abandoned Dispatch pointer flight clean up.
    db.markAsUndelivered([message.id], `dispatch:${dispatch.id}`)

    // Releasing the stale Dispatch stamp must not re-arm a push the coordinator already had.
    expect(db.getMessageById(message.id)).toMatchObject({
      to_handle: `run:${run.id}`,
      delivered_at: expect.any(String)
    })
    db.close()
  })

  it('clears the push stamp when unread mail changes mailbox owner', () => {
    const db = createDatabase('orca-dispatch-push-reroute-')
    const { run, dispatch } = dispatchToWorker(db)
    const message = sendToDispatch(db, run.id, dispatch.id, 'push authorization')
    db.markAsDelivered([message.id])

    db.routeUnreadDispatchMailboxToRunMailbox(dispatch.id, run.id)

    // The coordinator inherits the mail unpointed, so it must be pushable again.
    expect(db.getMessageById(message.id)).toMatchObject({
      to_handle: `run:${run.id}`,
      read: 0,
      delivered_at: null
    })
    db.close()
  })
})
