// Every way a host stop or close begins writes the Stop's event with its reason, before it ends the
// child, and only when it ends work: a running turn or a send. A stop that ends nothing writes
// nothing, quit writes nothing (its resume marker records why), and any later Stop event ends a
// person's Stop pause.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

/** Swept only when a test ticks it. */
const MANUAL_IDLE_SWEEP = { idleMs: 0, intervalMs: 60 * 60 * 1000 }

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

/** Every Stop event in the live epoch, oldest first. */
function stopEvents(): JournalStopEvent[] {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent] : []
  )
}

/** The Stop events as the provider's close finds them, or null when no close ran. */
function stopEventsAtClose(): { events: JournalStopEvent[] | null } {
  const seen: { events: JournalStopEvent[] | null } = { events: null }
  rig.closeSession.mockImplementationOnce(async () => {
    // The event is issued before the kill, never awaited by it: the journal writes it ahead of
    // anything the kill makes the child write.
    await new Promise((resolve) => setImmediate(resolve))
    seen.events = stopEvents()
    return true
  })
  return seen
}

async function runningTurn(turnId = 'turn-1'): Promise<string> {
  const working = await rig.workingSend()
  await journal().appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 999 },
    { kind: 'turn', turnId, state: 'running', startedAt: 1 },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  return working
}

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error(`expected a queued receipt: ${JSON.stringify(queued)}`)
  }
  return queued.value.queued.messageId
}

function idleSweep() {
  return rig.host.collaboratorsForTests().lifetime.idleSweep
}

describe('every Stop entry writes its event, with its reason, before it ends the child', () => {
  it.each([
    // A person closing this chat: its tab, its launch, or a /clear that replaces it.
    ['user-close' as const],
    // A worktree teardown, an orchestration stop, a discarded half-started worker, a tab cleanup.
    ['evict' as const]
  ])('a %s close of a running turn', async (cause) => {
    rig = await createQueuedMessageTestRig()
    await runningTurn()
    const atClose = stopEventsAtClose()

    await rig.host.close(HOST_TEST_SESSION, cause)

    expect(atClose.events).toEqual([{ reason: cause, turnId: 'turn-1', at: expect.any(Number) }])
  })

  it("a person's Stop of a running turn", async () => {
    rig = await createQueuedMessageTestRig()
    await runningTurn()
    let atInterrupt: JournalStopEvent[] = []
    rig.cancelTurn.mockImplementationOnce(async () => {
      atInterrupt = stopEvents()
      return { cancelled: true }
    })

    await rig.stop()

    expect(atInterrupt).toEqual([
      expect.objectContaining({ reason: 'user-stop', turnId: 'turn-1', at: expect.any(Number) })
    ])
  })

  it('the idle sweep stopping a start, with its send, that never landed', async () => {
    rig = await createQueuedMessageTestRig({
      starting: true,
      restartable: true,
      idleSweep: MANUAL_IDLE_SWEEP
    })
    rig.send('work on this')
    await eventually(async () =>
      expect(rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.phase).toBe(
        'starting'
      )
    )
    const atClose = stopEventsAtClose()

    await idleSweep().tick()

    expect(atClose.events).toEqual([{ reason: 'host-stop', at: expect.any(Number) }])
  })

  it('writes nothing when it ends nothing: a close of a chat at rest', async () => {
    rig = await createQueuedMessageTestRig()
    const atClose = stopEventsAtClose()

    await rig.host.close(HOST_TEST_SESSION, 'user-close')

    expect(atClose.events).toEqual([])
  })

  // The person's reason survives to the turn's end.
  it("writes nothing when the host evicts a turn a person's Stop is still ending", async () => {
    rig = await createQueuedMessageTestRig()
    await runningTurn()
    expect(await rig.stop()).toMatchObject({ ok: true })
    const atClose = stopEventsAtClose()

    await rig.host.close(HOST_TEST_SESSION, 'evict')

    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop'])
    const { items } = await rig.host.journalSnapshot(HOST_TEST_SESSION)
    expect(items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation'
    })
  })

  // A drain still running after its bound may hold the turn's row: the agent reads working.
  it("writes a person's close while the running turn's row waits behind a slow sink", async () => {
    rig = await createQueuedMessageTestRig()
    const sent = await rig.workingSend()
    const open = journal()
    const append = open.appendItem.bind(open)
    let held = false
    vi.spyOn(open, 'appendItem').mockImplementation(async (...args: Parameters<typeof append>) => {
      if (!held && args[1].kind === 'turn' && args[1].state === 'running') {
        held = true
        await new Promise((resolve) => setTimeout(resolve, 1_500))
      }
      return append(...args)
    })
    rig.host['runtimeState'].eventSinkFor(HOST_TEST_SESSION).sink.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 999 },
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'running',
        startedAt: Date.now(),
        userItemId: agentJournalSubmissionKey(sent)
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    // The echo's acceptance lands straight in the journal, ahead of the turn row.
    await rig.settleAccepted(sent, 'turn-1')
    const atClose = stopEventsAtClose()

    await rig.host.close(HOST_TEST_SESSION, 'user-close')

    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-close'])
  }, 20_000)

  // A slow drain counts as working only for a send accepted with no turn row yet.
  // A steer delivered into the running turn opens no turn of its own, so it is never owed one.
  it.each([
    ['', false],
    [', its last send a steer into the stopped turn', true]
  ])(
    'writes nothing when the drain runs long as it evicts a chat at rest%s',
    async (_label, steered) => {
      rig = await createQueuedMessageTestRig()
      const working = await rig.workingSend()
      const opener = agentJournalSubmissionKey(working)
      const identity = {
        provider: 'codex' as const,
        threadId: 'thread-1',
        turnId: 'turn-1',
        ordinal: 999
      }
      const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      await journal().appendItem(
        identity,
        { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1, userItemId: opener },
        scope
      )
      if (steered) {
        const steer = rig.send('steer the running turn')
        await steer.result
        await eventually(async () =>
          expect((await rig.submission(steer.id))?.handedOverAt).toBeDefined()
        )
        await rig.settleAccepted(steer.id, 'turn-1')
        expect(
          journal()
            .snapshot()
            .items.find((item) => item.itemId === agentJournalSubmissionKey(steer.id))?.turnScope
        ).toMatchObject({ kind: 'turn' })
      }
      await queuedDraft('queued behind the turn')
      expect(await rig.stop()).toMatchObject({ ok: true })
      await rig.settleAccepted(working, 'turn-1')
      await journal().appendItem(
        identity,
        {
          kind: 'turn',
          turnId: 'turn-1',
          state: 'interrupted',
          completedAt: Date.now(),
          userItemId: opener
        },
        scope
      )
      expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
      const sink = rig.host['runtimeState'].eventSinkFor(HOST_TEST_SESSION)
      const drained = sink.drained.bind(sink)
      vi.spyOn(sink, 'drained')
        .mockImplementationOnce(
          () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1_500))
        )
        .mockImplementation(drained)
      const atClose = stopEventsAtClose()

      await rig.host.close(HOST_TEST_SESSION, 'evict')

      expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop'])
      // The close hides the row, as every close of a chat does; the Stop still pauses.
      expect(await rig.queuePause()).toBeNull()
      expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toContain('stopped')
    },
    20_000
  )

  // The drain is best effort: when it fails, the journal as it stands says the agent rests.
  it('writes nothing when the drain fails as it evicts a chat at rest', async () => {
    rig = await createQueuedMessageTestRig()
    const working = await runningTurn()
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(working, 'stopped')
    await journal().appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 999 },
      { kind: 'turn', turnId: 'turn-1', state: 'interrupted', completedAt: Date.now() },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect(journal().activeTurnId()).toBeNull()
    const sink = rig.host['runtimeState'].eventSinkFor(HOST_TEST_SESSION)
    const drained = sink.drained.bind(sink)
    vi.spyOn(sink, 'drained')
      .mockResolvedValueOnce({ ok: false, error: new Error('drain lost once') })
      .mockImplementation(drained)
    const atClose = stopEventsAtClose()

    await rig.host.close(HOST_TEST_SESSION, 'evict')

    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop'])
  })

  // A later stop joins a close whose exit was unproven: the same close, so its event stands alone.
  it.each([['user-close' as const], ['evict' as const]])(
    'writes one event for a close (%s) whose exit was unproven, and none for a stop that joins it',
    async (cause) => {
      rig = await createQueuedMessageTestRig({ idleSweep: MANUAL_IDLE_SWEEP })
      await runningTurn()
      rig.closeSession.mockResolvedValueOnce(false)
      const session = () => rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!

      await rig.host.close(HOST_TEST_SESSION, cause).catch(() => undefined)
      expect(session().child?.close).toMatchObject({ cause })
      expect(stopEvents()).toEqual([{ reason: cause, turnId: 'turn-1', at: expect.any(Number) }])

      await rig.host['tasks'].serialize(HOST_TEST_SESSION, () =>
        rig.host['lifetime'].stopAgent(HOST_TEST_SESSION, { cause: 'host-stop' })
      )

      expect(session().child).toBeNull()
      expect(stopEvents().map((event) => event.reason)).toEqual([cause])
      expect(session().lastEndedChild?.cause).toBe(cause)
    }
  )

  it("writes nothing at quit, whose resume marker's trigger records why", async () => {
    rig = await createQueuedMessageTestRig()
    await runningTurn()
    const atClose = stopEventsAtClose()

    await rig.host.flushAllStreamedEvents({ trigger: 'quit' })

    expect(atClose.events).toEqual([])
  })
})

describe("a person's Stop pause and the Stop events after it", () => {
  it('holds through an idle eviction of the chat at rest, which writes nothing', async () => {
    rig = await createQueuedMessageTestRig({ idleSweep: MANUAL_IDLE_SWEEP })
    const working = await rig.workingSend()
    const held = await queuedDraft('queued behind the turn')
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(working, 'stopped')
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    const atClose = stopEventsAtClose()

    await idleSweep().tick()

    expect(rig.closeSession).toHaveBeenCalledTimes(1)
    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop'])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.handoff(held)).toBeUndefined()
  })

  // The sweep rests an agent with no turn running even while a send whose reply was lost waits,
  // so that send cannot pin it forever; that rest ends no work, so it writes no event.
  it('holds through an idle eviction that retires a send whose reply was lost', async () => {
    rig = await createQueuedMessageTestRig({ idleSweep: MANUAL_IDLE_SWEEP })
    const working = await rig.workingSend()
    await queuedDraft('queued behind the turn')
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(working, 'stopped')
    rig.dispatch.mockRejectedValueOnce(new Error('reply lost'))
    const lost = rig.send('sent as the reply was lost')
    await lost.result
    await eventually(async () =>
      expect(await rig.submission(lost.id)).toMatchObject({ dispatchState: 'unknown' })
    )
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    const atClose = stopEventsAtClose()

    await idleSweep().tick()

    expect(rig.closeSession).toHaveBeenCalledTimes(1)
    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop'])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  // A start that carries no send ends no turn and no send, so stopping it writes nothing.
  it('holds through the sweep stopping a start that carries no send, which writes nothing', async () => {
    rig = await createQueuedMessageTestRig({ starting: true, idleSweep: MANUAL_IDLE_SWEEP })
    expect(rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.phase).toBe(
      'starting'
    )
    // A person's Stop of an earlier turn still pauses the queue.
    await journal().appendStopEvent({ reason: 'user-stop', caller: 'client-1' }, 1)
    expect(journal().queuedMessages.userStopInForce()).not.toBeNull()
    const atClose = stopEventsAtClose()

    await idleSweep().tick()

    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop'])
    expect(journal().queuedMessages.userStopInForce()).not.toBeNull()
  })

  it('ends when a host eviction ends a running turn: that Stop event is later', async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    await queuedDraft('queued behind the turn')
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(working, 'stopped')
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    // Orchestration mail's turn runs, but its send is not accepted yet, so it lifts nothing yet.
    await rig.send('mail for the lead').result
    await journal().appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-mail', ordinal: 999 },
      { kind: 'turn', turnId: 'turn-mail', state: 'running', startedAt: 1 },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toEqual(['stopped'])
    const atClose = stopEventsAtClose()

    await rig.host.close(HOST_TEST_SESSION, 'evict')

    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop', 'evict'])
    expect(await rig.queuePause()).not.toEqual({ reason: 'stopped' })
  })

  it('ends when the host stops a start that never landed: that Stop event is later', async () => {
    rig = await createQueuedMessageTestRig({
      starting: true,
      restartable: true,
      idleSweep: MANUAL_IDLE_SWEEP
    })
    const working = await rig.workingSend()
    const held = await queuedDraft('queued behind the turn')
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(working, 'stopped')
    // The agent at rest goes, writing nothing; mail then starts a new child, which never lands.
    await idleSweep().tick()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    rig.send('mail for the lead')
    await eventually(async () =>
      expect(rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.phase).toBe(
        'starting'
      )
    )
    const atClose = stopEventsAtClose()

    await idleSweep().tick()

    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop', 'host-stop'])
    expect(await rig.queuePause()).not.toEqual({ reason: 'stopped' })
    // The pause ended with the host's stop, so the card goes out to the next start.
    await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
  })
})
