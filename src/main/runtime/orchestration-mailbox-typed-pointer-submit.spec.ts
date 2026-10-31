import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import {
  checkBoundMailbox,
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  isMailboxPointer,
  pointerCount,
  PTY_ID,
  registerSecondPane,
  SECOND_LAUNCH_TOKEN,
  SECOND_LEAF_ID,
  SECOND_PANE_KEY,
  SECOND_PTY_ID,
  SECOND_TERMINAL_HANDLE,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

describe('orchestration typed pointer submission', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['claims', false],
    ['reads', true]
  ])('still submits a typed pointer when a check %s its mail before Enter', async (_name, ack) => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Explicit-check Run')
    const message = insertDirectRunMessage(db, run.id, 'Checked before Enter')
    const enterCount = (): number =>
      harness.write.mock.calls.filter(([, payload]) => payload === '\r').length

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    const checked = await checkBoundMailbox(harness.runtime)
    expect(checked).toMatchObject({ runId: run.id, count: 1 })
    if (ack) {
      await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })
      expect(db.getMessageById(message.id)?.read).toBe(1)
    }

    await vi.advanceTimersByTimeAsync(500)
    // A skipped Enter would strand the typed line and hold every later pointer as a draft.
    expect(enterCount()).toBe(1)
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })

    if (!ack) {
      await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })
    }
    insertDirectRunMessage(db, run.id, 'Next wake')
    harness.runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(harness.write)).toBe(2)
    expect(enterCount()).toBe(2)
    db.close()
  })

  it.each([
    ['after', false],
    ['in the same millisecond as', true]
  ])('leaves the line to the user when they type %s staging', async (_name, typedBeforeStage) => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'User-input Run')
    const message = insertDirectRunMessage(db, run.id, 'Typed over before Enter')
    const inputAt = Date.now()
    if (typedBeforeStage) {
      harness.runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'earlier', inputAt)
    }

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    const checked = await checkBoundMailbox(harness.runtime)
    await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })
    harness.runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'my own draft', inputAt)

    await vi.advanceTimersByTimeAsync(500)
    // An Enter now could submit the user's draft, or the wake line a second time.
    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(0)
    db.close()
  })

  it('hands rebound mail to its new owner when the user types over the old line', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    const message = insertDirectRunMessage(db, runA.id, 'Run A completion')
    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)

    createBoundRun(db, 'Run B')
    registerSecondPane(harness.runtime, SECOND_LEAF_ID, false)
    db.bindRun({
      runId: runA.id,
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    harness.runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'my own draft')
    harness.runtime.onPtyData(SECOND_PTY_ID, '\x1b]0;Codex working\x07', 1)
    harness.runtime.onPtyData(SECOND_PTY_ID, '\x1b]0;Codex done\x07', 2)
    await vi.advanceTimersByTimeAsync(500)

    expect(
      harness.write.mock.calls.filter(([ptyId, payload]) => ptyId === PTY_ID && payload === '\r')
    ).toHaveLength(0)
    expect(
      harness.write.mock.calls.filter(
        ([ptyId, payload]) => ptyId === SECOND_PTY_ID && isMailboxPointer(payload)
      )
    ).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(harness.runtime, {
      terminal: SECOND_TERMINAL_HANDLE,
      paneKey: SECOND_PANE_KEY,
      launchToken: SECOND_LAUNCH_TOKEN
    })
    expect(checked).toMatchObject({ runId: runA.id, count: 1 })
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    db.close()
  })
})
