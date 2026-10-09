// The queue's automatic send when storage fails: another connection holding the database is
// retried with nothing shown, and only a refusal, or contention past its retries, holds the card
// with "Couldn't send". An exited child's lease not yet released keeps the drain from trying.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { exitChild, reconciled } from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  isTransientStorageFailure,
  StructuredAgentSessionQueuedDrainRetry
} from './structured-agent-session-queued-drain-retry'

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  vi.useRealTimers()
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

/** A card queued behind a working turn. */
async function queuedBehindWork(): Promise<{
  current: QueuedMessageTestRig
  draftId: string
  working: string
}> {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const current = rig
  const working = await current.workingSend()
  const queued = await current.send('after this', 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return { current, draftId: queued.value.queued.messageId, working }
}

async function pausedReason(current: QueuedMessageTestRig): Promise<string | undefined> {
  const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
  return page.ok ? page.page.queuedMessages?.[0]?.pausedReason : undefined
}

const locked = () => Object.assign(new Error('database is locked'), { errcode: 5 })

describe("the queue's automatic send", () => {
  it("waits for an exited child's release, then sends on its own, never marked", async () => {
    const { current, draftId } = await queuedBehindWork()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const release = vi
      .spyOn(current.store, 'transitionHandoff')
      .mockRejectedValue(new Error('database is locked'))

    await exitChild(current)
    await new Promise((resolve) => setTimeout(resolve, 250))
    // The host reads nothing working, yet the drain does not try while the release is owed.
    expect(await current.handoff(draftId)).toBeUndefined()
    expect(await pausedReason(current)).toBeUndefined()

    release.mockRestore()
    await reconciled(current)
    await eventually(async () => expect(await current.handoff(draftId)).toBeDefined())
  })

  it('retries a send that meets a locked database, and sends it with nothing shown', async () => {
    const { current, draftId, working } = await queuedBehindWork()
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockRejectedValueOnce(locked())
      .mockRejectedValueOnce(locked())

    await current.settleAccepted(working, 'a')
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1))
    expect(await pausedReason(current)).toBeUndefined()
    await eventually(async () => expect(await current.handoff(draftId)).toBeDefined())
    expect(append.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('holds the card with "Couldn\'t send" at once for a refusal', async () => {
    const { current, working } = await queuedBehindWork()
    vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockRejectedValueOnce(
      new Error('disk full')
    )

    await current.settleAccepted(working, 'a')
    await eventually(async () =>
      expect(await pausedReason(current)).toBe(QUEUED_MESSAGE_PAUSED_SEND_FAILED)
    )
  })
})

describe('a send that keeps meeting a locked database', () => {
  it('is given up after a bounded run, and only then held', () => {
    vi.useFakeTimers()
    const wake = vi.fn()
    const retry = new StructuredAgentSessionQueuedDrainRetry(wake)
    for (let attempt = 1; attempt < 10; attempt += 1) {
      expect(retry.retryLater('chat', 'card')).toBe(true)
      expect(retry.waiting('chat', 'card')).toBe(true)
      vi.advanceTimersByTime(30_000)
      expect(retry.waiting('chat', 'card')).toBe(false)
    }
    expect(wake).toHaveBeenCalledTimes(9)
    // The tenth failure falls back to the held card.
    expect(retry.retryLater('chat', 'card')).toBe(false)
  })

  it('starts over for a different card, and tells contention from other failures', () => {
    vi.useFakeTimers()
    const retry = new StructuredAgentSessionQueuedDrainRetry(() => undefined)
    for (let attempt = 1; attempt < 10; attempt += 1) {
      retry.retryLater('chat', 'card')
    }
    expect(retry.retryLater('chat', 'other')).toBe(true)
    expect(isTransientStorageFailure(locked())).toBe(true)
    expect(isTransientStorageFailure(new Error('wrapped', { cause: locked() }))).toBe(true)
    expect(isTransientStorageFailure(new Error('disk full'))).toBe(false)
  })
})
