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
  temporaryDirectories,
  PTY_ID,
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

  it('stops typing the pointer once its delivery is acknowledged', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Ack-gated notice Run')
    const message = insertDirectRunMessage(db, run.id, 'First wake')
    const enterCount = (): number =>
      harness.write.mock.calls.filter(([, payload]) => payload === '\r').length

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    const checked = await checkBoundMailbox(harness.runtime)
    expect(checked.deliveryId).toEqual(expect.any(String))
    await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })
    expect(db.getMessageById(message.id)?.read).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(enterCount()).toBe(1)

    // Repeated redrive edges (idle events, pending redeliveries, timers) after the ack.
    for (let round = 0; round < 3; round += 1) {
      harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 1)
      await vi.advanceTimersByTimeAsync(1_000)
      harness.runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(pointerCount(harness.write)).toBe(1)
    expect(enterCount()).toBe(1)
    db.close()
  })

  it('does not name an acknowledged delivery in a later pointer', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Ack-gated notice Run')
    insertDirectRunMessage(db, run.id, 'First wake')

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    const checked = await checkBoundMailbox(harness.runtime)
    expect(checked.deliveryId).toEqual(expect.any(String))
    await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })

    insertDirectRunMessage(db, run.id, 'Newer mail after the ack')
    harness.runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(500)
    const pointers = harness.write.mock.calls.filter(([, payload]) => isMailboxPointer(payload))
    expect(pointers).toHaveLength(2)
    // The named batch is acknowledged; a later reminder must not hold the agent to it again.
    expect(String(pointers[1]![1])).not.toContain('which you have not acknowledged')
    expect(String(pointers[1]![1])).not.toContain(checked.deliveryId!)
    db.close()
  })
})
