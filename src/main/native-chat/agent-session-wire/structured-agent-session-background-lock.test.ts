// Background bookkeeping under another connection's write lock fails at once (no main-thread or
// lane stall), every frame reads the dead turn as it will settle, and the retry lands it after.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { runningStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  exitChild,
  leaveUnfinishedWork,
  REASONING,
  TURN_KEY,
  turnState
} from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
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

/** Every frame a chat client and the session list receive, as each reduces it. */
function recordFrames(current: QueuedMessageTestRig) {
  const chats: StructuredAgentSessionState[] = []
  const rows: AgentSessionStatusSummary[] = []
  let chat = EMPTY_STRUCTURED_AGENT_SESSION
  current.host.subscribe({
    id: 'chat-1',
    sessionId: SESSION,
    emit: (event) => {
      chat = reduceStructuredAgentSession(chat, { type: 'event', event: structuredClone(event) })
      chats.push(chat)
    }
  })
  current.host.subscribeStatus({
    id: 'list-1',
    emit: (event) => {
      const row =
        event.type === 'status'
          ? event.session
          : event.type === 'snapshot'
            ? event.sessions.find((session) => session.sessionId === SESSION)
            : undefined
      if (row?.sessionId === SESSION) {
        rows.push(structuredClone(row))
      }
    }
  })
  return { chats, rows }
}

describe('under another connection’s write lock', () => {
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

    // One wait, the row's own 5 s busy timeout: the sink reports its failure as it ends.
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

  it('a relaunch waits only for canonical send recovery, then its background cleanup lands', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })

    // Only the earlier handed send's canonical recovery uses the ordinary foreground writer.
    const waiting: unknown[] = []
    let held = false
    const transaction = JournalHostDatabase.prototype.transaction
    vi.spyOn(JournalHostDatabase.prototype, 'transaction').mockImplementation(function (
      this: JournalHostDatabase,
      run,
      options
    ) {
      if (held && !options?.background) {
        waiting.push(new Error('a write that waits for the lock'))
      }
      return transaction.call(this, run, options)
    })

    // Held from before this process starts: reconcile, restore and scan all meet it.
    const stall = await longestStall(() =>
      current.crashRestartHostProcess(async () => {
        const { released } = await holdWriteLock(current.root, LOCK_MS)
        held = true
        void released.then(() => (held = false))
      })
    )
    expect(waiting).toHaveLength(1)
    expect(stall).toBeGreaterThan(LOCK_MS / 2)
    expect(stall).toBeLessThan(LOCK_MS + 1_500)
    // Once it lifts the retry reconciles, resolves recovery and settles (the probe proves nothing).
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
    // The lock arrives just as the drain heals its bookkeeping before sending.
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

  it('reads the dead turn interrupted in every frame until its settlement lands', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await current.send('after this', 'queue-if-active').result
    await leaveUnfinishedWork(current)
    const frames = recordFrames(current)
    await vi.waitFor(() => expect(frames.chats.at(-1)?.working).toBe(true))
    const { released } = await holdWriteLock(current.root, 1_200)
    const before = { chats: frames.chats.length, rows: frames.rows.length }

    await exitChild(current)
    const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
    await released
    // Nothing landed: what the frames read is derived from the death alone.
    expect(turnState(current)).toBe('running')

    const chats = frames.chats.slice(before.chats)
    const rows = frames.rows.slice(before.rows)
    expect(chats.length).toBeGreaterThan(0)
    expect(rows.length).toBeGreaterThan(0)
    for (const chat of [...chats, page.ok ? page.page : null]) {
      expect(chat?.latestTurn?.turn.state).toBe('interrupted')
      expect(chat?.working).toBe(false)
      // So no turn runs to steer into: the card's control is Send.
      expect(chat?.nextQueuedMessageId ?? null).toBeNull()
    }
    for (const chat of chats) {
      expect(runningStructuredAgentSessionTurnId(chat)).toBeNull()
    }
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
    }

    // Once the lock lifts, the retry writes what the frames already said.
    await vi.waitFor(() => expect(turnState(current)).toBe('interrupted'), { timeout: 8_000 })
  }, 20_000)
})

describe('a refused automatic send whose stored hold fails too', () => {
  it('keeps A held through deleting B, replay and refusal, until A itself is deleted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    const working = await current.workingSend()
    const queued = await current.send('after this', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const other = current.send('another card', 'queue-if-active')
    expect(await other.result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    const diskFull = () => Object.assign(new Error('database or disk is full'), { errcode: 13 })
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockRejectedValueOnce(diskFull())
    const hold = vi.spyOn(JournalQueuedMessages.prototype, 'hold').mockRejectedValueOnce(diskFull())

    await current.settleAccepted(working, 'a')
    await vi.waitFor(() => expect(hold).toHaveBeenCalledTimes(1))
    const deletion = hostTestOperationId()
    expect(await current.deleteQueued(other.id, deletion)).toMatchObject({
      ok: true,
      value: { deleted: true }
    })
    expect(await current.deleteQueued(other.id, deletion)).toMatchObject({ ok: true })
    const messageId = queued.value.queued.messageId
    expect(
      await current.host.queuedMessageSend(QUEUED_RIG_CALLER, {
        envelope: {
          ...current.envelope(
            { messageId },
            'agentSession.queuedMessageSend',
            hostTestOperationId()
          ),
          payloadFingerprint: 'mismatched-send-payload'
        },
        messageId
      })
    ).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_conflict',
        details: { reason: 'fingerprintMismatch' }
      }
    })
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
    expect(await current.deleteQueued(messageId)).toMatchObject({
      ok: true,
      value: { deleted: true }
    })
    expect(await current.drafts()).toEqual([])
    expect(append).toHaveBeenCalledTimes(1)
  })
})
