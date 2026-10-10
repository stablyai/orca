// The queue's automatic send when storage fails: another connection holding the database is
// retried with nothing shown, and only a refusal, or contention past its retries, holds the card
// with "Couldn't send". A worker still owing an ended generation's release keeps the drain from
// trying, and while the drain waits no client is told the card sends next (it would read Working).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  exitChild,
  reconciled,
  REJECT_RECOVERED_ROWS
} from './structured-agent-session-leftover-settlement.test-fixture'
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

/** What a client reads after each frame: Working is the host's, or a card it is told sends next. */
async function watchChat(current: QueuedMessageTestRig) {
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const reads: { working: boolean; turnRunning: boolean }[] = []
  await current.host.subscribe({
    id: 'chat',
    sessionId: SESSION,
    emit: (event) => {
      state = reduceStructuredAgentSession(state, { type: 'event', event })
      reads.push({
        working: state.working === true || (state.nextQueuedMessageId ?? null) !== null,
        turnRunning: state.latestTurn?.turn.state === 'running'
      })
    }
  })
  return reads
}

const statusWorking = (current: QueuedMessageTestRig) =>
  current.host.readStatusSummary(SESSION)?.status === 'working'

describe("the queue's automatic send", () => {
  it("waits for an exited child's release, then sends on its own, never marked", async () => {
    const { current, draftId } = await queuedBehindWork()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const release = vi
      .spyOn(current.store, 'transitionHandoff')
      .mockRejectedValue(new Error('database is locked'))
    const reads = await watchChat(current)
    const before = reads.length

    await exitChild(current)
    await new Promise((resolve) => setTimeout(resolve, 250))
    // The host reads nothing working, yet the drain does not try while the release is owed.
    expect(await current.handoff(draftId)).toBeUndefined()
    expect(await pausedReason(current)).toBeUndefined()
    // The chat reads idle, as the status does: no card is named as sent next while it waits.
    expect(reads.length).toBeGreaterThan(before)
    expect(reads.at(-1)).toEqual({ working: false, turnRunning: false })
    expect(statusWorking(current)).toBe(false)

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
    const reads = await watchChat(current)

    await current.settleAccepted(working, 'a')
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1))
    expect(await pausedReason(current)).toBeUndefined()
    // Waiting out the backoff, the card is not named as sent next: the chat reads idle meanwhile.
    await vi.waitFor(() => expect(reads.at(-1)?.working).toBe(false))
    expect(statusWorking(current)).toBe(false)
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

describe('a dead turn the worker settles while the release is still owed', () => {
  it('publishes one view: no frame reads Working over it, and the card sends once released', async () => {
    const { current, draftId } = await queuedBehindWork()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const release = vi.spyOn(current.store, 'transitionHandoff').mockRejectedValue(locked())
    const { db } = openTestJournalHostDatabase(current.root)
    db.exec(REJECT_RECOVERED_ROWS)
    const reads = await watchChat(current)
    const before = reads.length

    // The exit's own settlement and release both fail; the worker settles the turn a pass later.
    await exitChild(current)
    db.exec('DROP TRIGGER reject_recovered')
    const settled = (await current.host.journalSnapshot(SESSION)).items.length
    await eventually(async () =>
      expect((await current.host.journalSnapshot(SESSION)).items.length).toBeGreaterThan(settled)
    )
    expect(current.host.collaboratorsForTests().reconciliation.owes(SESSION)).toBe(true)
    expect(reads.slice(before).filter((read) => read.working)).toEqual([])
    expect(statusWorking(current)).toBe(false)

    release.mockRestore()
    await reconciled(current)
    await eventually(async () => expect(await current.handoff(draftId)).toBeDefined())
  })
})

describe('a send that keeps meeting a locked database', () => {
  const journal = {}

  it('is given up after a bounded run, and only then held', () => {
    vi.useFakeTimers()
    const wake = vi.fn()
    const retry = new StructuredAgentSessionQueuedDrainRetry(wake)
    for (let attempt = 1; attempt < 10; attempt += 1) {
      expect(retry.retryLater('chat', 'card', journal)).toBe(true)
      expect(retry.waiting('chat', 'card', journal)).toBe(true)
      vi.advanceTimersByTime(30_000)
      expect(retry.waiting('chat', 'card', journal)).toBe(false)
    }
    expect(wake).toHaveBeenCalledTimes(9)
    // The tenth failure falls back to the held card.
    expect(retry.retryLater('chat', 'card', journal)).toBe(false)
  })

  it('starts over for another card, a reopened chat, or a card a person moved on', () => {
    vi.useFakeTimers()
    const retry = new StructuredAgentSessionQueuedDrainRetry(() => undefined)
    const exhaust = (messageId: string, on: object) => {
      for (let attempt = 1; attempt < 10; attempt += 1) {
        retry.retryLater('chat', messageId, on)
      }
    }
    exhaust('card', journal)
    expect(retry.retryLater('chat', 'other', journal)).toBe(true)
    exhaust('card', journal)
    expect(retry.retryLater('chat', 'card', {})).toBe(true)
    exhaust('card', journal)
    retry.settled('chat')
    expect(retry.retryLater('chat', 'card', journal)).toBe(true)
  })

  it('keeps one timer per chat: a new failure replaces the wait before it', () => {
    vi.useFakeTimers()
    const wake = vi.fn()
    const retry = new StructuredAgentSessionQueuedDrainRetry(wake)
    retry.retryLater('chat', 'card', journal)
    retry.retryLater('chat', 'card', journal)
    vi.advanceTimersByTime(60_000)
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('tells contention from other failures', () => {
    expect(isTransientStorageFailure(locked())).toBe(true)
    expect(isTransientStorageFailure(new Error('wrapped', { cause: locked() }))).toBe(true)
    expect(isTransientStorageFailure(new Error('disk full'))).toBe(false)
  })
})

describe('an exited child whose release the worker gave up on', () => {
  it('no longer holds the card: once the worker retires, the queue sends it on its own', async () => {
    const { current, draftId } = await queuedBehindWork()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const release = vi
      .spyOn(current.store, 'transitionHandoff')
      .mockRejectedValue(new Error('database is locked'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await exitChild(current)
    const { reconciliation } = current.host.collaboratorsForTests()
    for (let step = 0; step < 12 && reconciliation.owes(SESSION); step += 1) {
      await vi.advanceTimersByTimeAsync(31_000)
    }
    expect(reconciliation.owes(SESSION)).toBe(false)
    release.mockRestore()
    vi.useRealTimers()

    // Sent, or held with main's marker: never left waiting with neither.
    await eventually(async () =>
      expect(
        Boolean(await current.handoff(draftId)) || (await pausedReason(current)) !== undefined
      ).toBe(true)
    )
  })
})
