import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import {
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { checkBoundMailbox } from './orchestration-mailbox-check.test-fixture'

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
})
