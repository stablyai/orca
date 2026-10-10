// Every background path meeting another connection's write lock: an exit's own settlement and
// release, the retry's recovery of a pending rewind, and the queue's automatic drain healing its
// bookkeeping. Each fails at once, never holding the main thread or the chat's lane for the busy
// timeout, and the retry lands the work once the lock lifts. A refusal of the automatic send whose
// stored hold also fails still shows the card as not sent.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  exitChild,
  leaveUnfinishedWork,
  REASONING,
  TURN_KEY,
  turnState
} from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { retryOwes } from './structured-agent-session-retry.test-fixture'
import {
  holdWriteLock,
  longestStall,
  releaseWriteLocks,
  stallsOver
} from './structured-agent-session-write-lock.test-fixture'

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  await releaseWriteLocks()
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

/** Longer than a background write would ever wait, shorter than the busy timeout a person's has. */
const LOCK_MS = 1_200

describe('under another connection’s write lock', () => {
  it("an exit's own settlement and release fail at once, and the retry lands both after", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    await holdWriteLock(current.root, LOCK_MS)

    expect(await longestStall(() => exitChild(current))).toBeLessThan(60)
    expect(turnState(current)).toBe('running')

    await vi.waitFor(() => expect(turnState(current)).toBe('interrupted'), { timeout: 8_000 })
    await vi.waitFor(
      () => expect(current.store.getRecord(SESSION)?.lease.claimStatus).toBe('released'),
      { timeout: 8_000 }
    )
  }, 20_000)

  it("an agent dying mid-row costs one wait, its last row's, and the exit's bookkeeping none", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let sinkFailedAt = Infinity
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      if (String(message).includes('writing provider events to the chat journal failed')) {
        sinkFailedAt = performance.now()
      }
    })
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    // Longer than a person's write waits (`JOURNAL_BUSY_TIMEOUT_MS`), so the row's write gives up.
    await holdWriteLock(current.root, 6_500)

    const stalls = await stallsOver(60, async () => {
      // The agent's last words are a person's content: written as on main, waiting its 5 s.
      current
        .providerEvents()
        .appendItem(
          REASONING,
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'last words' }] },
          { turnScope: { kind: 'turn', turnItemId: TURN_KEY } }
        )
      await exitChild(current)
    })

    // One wait, the row's own busy timeout (5 s, plus SQLite's sleep granularity on a loaded
    // machine), and it is the row's: the sink reports its failure as that wait ends.
    expect(stalls).toHaveLength(1)
    const [wait] = stalls
    expect(wait!.ms).toBeLessThanOrEqual(5_500)
    expect(sinkFailedAt).toBeGreaterThanOrEqual(wait!.endedAt - wait!.ms)
    expect(sinkFailedAt).toBeLessThanOrEqual(wait!.endedAt)
    await vi.waitFor(() => expect(turnState(current)).toBe('interrupted'), { timeout: 10_000 })
    await vi.waitFor(
      () => expect(current.store.getRecord(SESSION)?.lease.claimStatus).toBe('released'),
      { timeout: 8_000 }
    )
  }, 30_000)

  it('a relaunch under the lock never holds the main thread, and its startup lands after', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })

    // Another process holds the lock from before this one starts: the restart reconcile, the
    // restore's reconcile and recovery, and the startup scan all meet it.
    expect(
      await longestStall(() =>
        current.crashRestartHostProcess(() => holdWriteLock(current.root, LOCK_MS))
      )
    ).toBeLessThan(60)
    // Once it lifts, the retry reconciles, resolves the recovery the restore could not, and settles
    // the turn as an unlocked startup does: the rig's probe proves nothing, so unverifiable.
    await vi.waitFor(() => expect(turnState(current)).toBe('unverifiable'), { timeout: 8_000 })
    expect(current.store.getRecord(SESSION)?.lease).toMatchObject({
      unreconciled: false,
      handoffStage: null
    })
  }, 20_000)

  it('a relaunch under a lock longer than a minute of rounds still settles once it lifts, unasked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    let released: Promise<void> = Promise.resolve()

    await current.crashRestartHostProcess(async () => {
      released = (await holdWriteLock(current.root, 40_000)).released
    })
    await released
    // Nothing else writes or reads: only the retry's own backoff, at most 2 s, comes back to it.
    await vi.waitFor(() => expect(turnState(current)).toBe('unverifiable'), { timeout: 3_000 })
    const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.working).toBe(false)
    expect(page.ok && page.page.latestTurn?.turn.state).not.toBe('running')
  }, 60_000)

  it('a pending rewind the retry recovers ends its round at once, never holding the lane', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    const { reconciliation, serialize } = current.host.collaboratorsForTests()
    await current.store.transitionHandoff(SESSION, (record) => ({
      ...record,
      rewind: {
        operationId: 'rewind-op',
        callerKey: 'client-1',
        itemId: agentJournalItemKey({ provider: 'claude', sessionId: 'claude-s', uuid: 'kept' }),
        expectedEpoch: 'epoch-x',
        phase: 'prepared',
        retained: []
      }
    }))
    await holdWriteLock(current.root, LOCK_MS)

    let laneWaited = Infinity
    const stall = await longestStall(async () => {
      reconciliation.signal(SESSION)
      await new Promise((resolve) => setImmediate(resolve))
      const queuedAt = performance.now()
      const lane = serialize(SESSION, async () => {
        laneWaited = performance.now() - queuedAt
      })
      await reconciliation.attempted(SESSION)
      await lane
    })
    expect(stall).toBeLessThan(60)
    expect(laneWaited).toBeLessThan(60)
    expect(current.store.getRecord(SESSION)?.rewind?.phase).toBe('prepared')
    expect(retryOwes(reconciliation, SESSION)).toBe(true)

    // Claude rewind is unsupported: once the lock lifts, the retry settles it refused.
    await vi.waitFor(
      () => expect(current.store.getRecord(SESSION)?.rewind?.phase).toBe('refused'),
      { timeout: 8_000 }
    )
  }, 20_000)

  it("the drain's bookkeeping heal fails at once, and its send waits for the retry", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    const working = await current.workingSend()
    await current.send('after this', 'queue-if-active').result
    // The turn's end wakes the drain, which heals skipped bookkeeping before it sends; another
    // connection takes the lock just as it starts.
    const owed = vi.spyOn(JournalQueuedMessages.prototype, 'settlementOwed').mockReturnValue(true)
    const heal = JournalQueuedMessages.prototype.settleOwed
    let waited = Infinity
    vi.spyOn(JournalQueuedMessages.prototype, 'settleOwed').mockImplementationOnce(async function (
      this: JournalQueuedMessages,
      ...args
    ) {
      owed.mockRestore()
      await holdWriteLock(current.root, LOCK_MS)
      const started = performance.now()
      try {
        return await heal.apply(this, args)
      } finally {
        waited = performance.now() - started
      }
    })

    await current.settleAccepted(working, 'a')
    await vi.waitFor(() => expect(waited).toBeLessThan(Infinity))
    expect(waited).toBeLessThan(60)
    expect(current.dispatch).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2), { timeout: 8_000 })
  }, 20_000)
})

describe('a refused automatic send whose stored hold fails too', () => {
  it('reads as not sent from memory, is not named next, and is not sent again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    const working = await current.workingSend()
    const queued = await current.send('after this', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const diskFull = () => Object.assign(new Error('database or disk is full'), { errcode: 13 })
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockRejectedValueOnce(diskFull())
    const hold = vi.spyOn(JournalQueuedMessages.prototype, 'hold').mockRejectedValueOnce(diskFull())

    await current.settleAccepted(working, 'a')
    await vi.waitFor(() => expect(hold).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 300))

    const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages).toEqual([
      expect.objectContaining({
        messageId: queued.value.queued.messageId,
        paused: true,
        pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
      })
    ])
    expect(page.ok && page.page.nextQueuedMessageId).toBeNull()
    expect(append).toHaveBeenCalledTimes(1)
  })
})
