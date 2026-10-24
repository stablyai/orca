import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../shared/agent-session-wire'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import {
  projectQueuedMessageCards,
  queuedMessageCardSteers,
  queuedMessagesQueuePause
} from '../../../renderer/src/components/native-chat/structured-agent-session-queued-cards'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

let rig: QueuedMessageTestRig

const MANUAL_IDLE_SWEEP = { idleMs: 0, intervalMs: 60 * 60 * 1000 }

beforeEach(async () => {
  vi.useFakeTimers()
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(async () => {
  try {
    await rig.dispose()
  } finally {
    vi.useRealTimers()
  }
})

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

async function published(): Promise<{
  queuePause: AgentSessionQueuePause | null
  nextQueuedMessageId: string | null
}> {
  const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return {
    queuePause: page.page.queuePause ?? null,
    nextQueuedMessageId: page.page.nextQueuedMessageId ?? null
  }
}

/** Include the hidden restart pause. */
function derivedPauses(): string[] {
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  return structuredQueuePauses(journal).map((pause) => pause.reason)
}

async function expectNothingSent(...draftIds: string[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(250)
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
}

type ClientView = {
  working: boolean
  stopLive: boolean
  header: boolean
  steers: boolean[]
  /** Card hold reason selects its caption; turn means ordinary waiting. */
  holds: string[]
  cards: number
  nextQueuedMessageId: string | null
}

function composerSend(text: string): ReturnType<QueuedMessageTestRig['send']> {
  return rig.send(text, 'queue-if-active')
}

/** Fold publications individually to catch transient client states. */
async function watchClient(): Promise<ClientView[]> {
  const views: ClientView[] = []
  const submissions = new Map<string, AgentJournalSubmission>()
  const turns = new Map<string, string>()
  let queued: AgentSessionQueuedMessage[] = []
  let queuePause: AgentSessionQueuePause | null = null
  let nextQueuedMessageId: string | null = null
  await rig.host.subscribe({
    id: 'client-view',
    sessionId: HOST_TEST_SESSION,
    emit: (event) => {
      if (event.type === 'end') {
        return
      }
      const rows = event.type === 'batch' ? event.batch : event.page
      for (const submission of rows.submissions) {
        submissions.set(submission.clientMessageId, submission)
      }
      for (const item of rows.items) {
        if (item.body.kind === 'turn') {
          turns.set(item.itemId, item.body.state)
        }
      }
      if (event.queuedMessages !== undefined) {
        queued = event.queuedMessages ?? []
        queuePause = event.queuePause ?? null
        nextQueuedMessageId = event.nextQueuedMessageId ?? null
      }
      const running = [...turns].find(([, state]) => state === 'running')?.[0] ?? null
      const all = [...submissions.values()]
      const hostWorking = isStructuredAgentSessionMainAgentWorking(running, all)
      // Match use-structured-agent-session.ts projection.
      const working = hostWorking || (nextQueuedMessageId !== null && !hostWorking)
      const cards = projectQueuedMessageCards(queued, all, { queuePaused: queuePause !== null })
      // Match use-structured-agent-session-queued-messages.ts projection.
      const header = queuedMessagesQueuePause(cards, queuePause) !== null
      views.push({
        working,
        stopLive: hostWorking,
        header,
        steers: cards.map((card) => queuedMessageCardSteers(card)),
        holds: cards.map((card) => card.hold),
        cards: cards.length,
        nextQueuedMessageId
      })
    }
  })
  return views
}

function expectOneWorkingRun(views: readonly ClientView[]): void {
  expect(views.filter((view) => !view.working)).toEqual([])
  expect(views.flatMap((view) => view.steers)).not.toContain(false)
  // Include the gap between settlement/Resume and the next handover.
  expect(views.some((view) => !view.stopLive && view.nextQueuedMessageId !== null)).toBe(true)
}

describe('a Stop holds the queue, in order', () => {
  it('a card typed while the Stop lands waits behind the held one; Resume sends both in order, never reading idle between them', async () => {
    const working = await rig.workingSend()
    const held = await queuedDraft('held by the stop')
    await rig.stop()
    const typed = await queuedDraft('typed while the stop lands')
    const views = await watchClient()
    expect(views.at(-1)).toMatchObject({ working: true, header: true })
    await rig.settleAccepted(working, 'stopped')
    await eventually(() => expect(views.at(-1)).toMatchObject({ working: false, header: true }))
    await expectNothingSent(held, typed)
    expect((await published()).queuePause).toEqual({ reason: 'stopped' })
    const resumedAt = views.length
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
    expect(await rig.handoff(typed)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(held), 'held')
    await eventually(async () => expect(await rig.handoff(typed)).toBeDefined())
    expectOneWorkingRun(views.slice(resumedAt))
  })

  it('after Resume over held cards the chat goes from idle and paused straight to working with Stop', async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    await queuedDraft('second')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const views = await watchClient()
    const before = views.length
    expect(views.at(-1)).toMatchObject({ working: false, header: true })
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    await eventually(() => expect(views.at(-1)?.stopLive).toBe(true))
    expectOneWorkingRun(views.slice(before))
  })
})

describe('after a restart, nothing sends by itself', () => {
  async function restartedWithCards(): Promise<{ first: string; second: string }> {
    await rig.workingSend()
    const first = await queuedDraft('A')
    const second = await queuedDraft('B')
    rig.crashRestartHostProcess()
    await published()
    return { first, second }
  }

  /** Restart after settling the old child so a later turn can reach the provider. */
  async function restartedIdleWithCards(): Promise<{ first: string; second: string }> {
    const working = await rig.workingSend()
    const first = await queuedDraft('A')
    const second = await queuedDraft('B')
    await rig.restartHostProcess()
    await rig.settleAccepted(working, 'before-restart')
    await published()
    return { first, second }
  }

  it('idle: no card is handed off across opens and commits, and no pause or next card is published', async () => {
    const { first, second } = await restartedWithCards()
    const views = await watchClient()
    await expectNothingSent(first, second)
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
    expect(derivedPauses()).toEqual(['restarted'])
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
    await expectNothingSent(first, second)
    expect(views.at(-1)).toMatchObject({
      working: false,
      header: false,
      cards: 2,
      holds: ['turn', 'turn'],
      steers: [true, true]
    })
    expect(await rig.drafts()).toEqual([
      { messageId: first, state: 'waiting' },
      { messageId: second, state: 'waiting' }
    ])
  })

  it("Resume: Orca's carry-on turn runs first, then A, then B, as if no restart happened", async () => {
    const { first, second } = await restartedIdleWithCards()
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
    const views = await watchClient()
    const carryOn = rig.send('continue where you left off')
    expect(await carryOn.result).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    await eventually(async () =>
      expect((await rig.submission(carryOn.id))?.handedOverAt).toBeDefined()
    )
    await expectNothingSent(first, second)
    await rig.settleAccepted(carryOn.id, 'carry-on')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(await rig.handoff(second)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(first), 'A')
    await eventually(async () => expect(await rig.handoff(second)).toBeDefined())
    expect(views.filter((view) => view.header)).toEqual([])
    expectOneWorkingRun(views.slice(views.findIndex((view) => view.working)))
  })

  it("the person's own message goes straight to the agent first, then A, then B", async () => {
    const { first, second } = await restartedIdleWithCards()
    const views = await watchClient()
    const message = composerSend('a new instruction')
    expect(await message.result).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    await eventually(async () =>
      expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    )
    await expectNothingSent(first, second)
    await rig.settleAccepted(message.id, 'message')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(await rig.handoff(second)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(first), 'A')
    await eventually(async () => expect(await rig.handoff(second)).toBeDefined())
    expect(views.filter((view) => view.header)).toEqual([])
  })

  it('Steer on a card sends it now, and the rest follow it in order', async () => {
    const { first, second } = await restartedIdleWithCards()
    expect(await rig.sendNow(second)).toMatchObject({
      ok: true,
      value: { submission: { queuedMessageId: second } }
    })
    await eventually(async () => expect((await rig.handoff(second))?.handedOverAt).toBeDefined())
    await expectNothingSent(first)
    await rig.settleAccepted(await rig.handoffId(second), 'B')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
  })

  it("a Stop's row from before the restart is not shown either; the carry-on releases every card, in order", async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('A')
    const second = await queuedDraft('B')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    expect((await published()).queuePause).toEqual({ reason: 'stopped' })
    await rig.restartHostProcess()
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
    expect(derivedPauses()).toEqual(['stopped', 'restarted'])
    const views = await watchClient()
    expect(views.at(-1)).toMatchObject({ working: false, header: false })
    const carryOn = rig.send('continue where you left off')
    await carryOn.result
    await expectNothingSent(first, second)
    await rig.settleAccepted(carryOn.id, 'carry-on')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(await rig.handoff(second)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(first), 'A')
    await eventually(async () => expect(await rig.handoff(second)).toBeDefined())
    expect(views.filter((view) => view.header)).toEqual([])
  })

  it('a card written after the restart waits while any card from before it waits; then it is an ordinary queue', async () => {
    const { first, second } = await restartedIdleWithCards()
    const message = rig.send('a new instruction')
    await message.result
    await eventually(async () =>
      expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    )
    const typed = await queuedDraft('typed while it waits')
    await rig.settleRejected(message.id, 'turn/start refused')
    await expectNothingSent(first, second, typed)
    expect(derivedPauses()).toEqual(['restarted'])
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
    expect(await rig.deleteQueued(first)).toMatchObject({ ok: true, value: { deleted: true } })
    await expectNothingSent(second, typed)
    expect(await rig.deleteQueued(second)).toMatchObject({ ok: true, value: { deleted: true } })
    await eventually(async () => expect(await rig.handoff(typed)).toBeDefined())
  })

  it('a hand-off the quit cut short goes back to waiting first, and nothing sends', async () => {
    rig.dispose()
    rig = await createQueuedMessageTestRig({ restartable: true, idleSweep: MANUAL_IDLE_SWEEP })
    const working = await rig.workingSend()
    const first = await queuedDraft('A')
    const second = await queuedDraft('B')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    // Resume must start a new child after idle retirement.
    await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
    // Hold spawn so the recorded handoff cannot reach the provider.
    const release = rig.holdNextStart()
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    const cutShort = await rig.handoffId(first)
    expect((await rig.handoff(first))?.handedOverAt).toBeUndefined()
    rig.crashRestartHostProcess()
    release()
    await published()
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([
        { messageId: first, state: 'waiting' },
        { messageId: second, state: 'waiting' }
      ])
    )
    await expectNothingSent()
    expect(await rig.handoffId(first)).toBe(cutShort)
    expect(await rig.handoff(second)).toBeUndefined()
    expect(derivedPauses()).toEqual(['restarted'])
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
  })

  it('an epoch replacement (a rewind or a legacy import) before any turn still holds the cards', async () => {
    // A prior turn makes the replacement epoch restate the lift.
    await rig.settleAccepted(await rig.workingSend(), 'earlier')
    const { first, second } = await restartedWithCards()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    await journal.replaceEpochItems(
      'legacy_import',
      structuredAgentSessionConversationFence(rig.store, HOST_TEST_SESSION),
      []
    )
    await expectNothingSent(first, second)
    expect(derivedPauses()).toEqual(['restarted'])
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
  })
})

describe('a message sent over a held queue', () => {
  async function heldIdleQueue() {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    const second = await queuedDraft('second')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const views = await watchClient()
    expect(views.at(-1)).toMatchObject({ working: false, header: true, cards: 2 })
    return { first, second, views }
  }

  it('goes out at once: the paused row goes as it is sent and never comes back, and the held cards follow it in order', async () => {
    const { first, second, views } = await heldIdleQueue()
    const message = composerSend('a new instruction')
    const sentAt = views.length
    expect(await message.result).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    // Hide the pause while its lifting turn is in flight; cards stay held until provider acceptance.
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
    expect(await rig.handoff(first)).toBeUndefined()
    await eventually(async () =>
      expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    )
    await eventually(() => expect(views.at(-1)?.stopLive).toBe(true))
    const acceptedAt = views.length
    await rig.settleAccepted(message.id, 'message')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(await rig.handoff(second)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(first), 'first')
    await eventually(async () => expect(await rig.handoff(second)).toBeDefined())
    const waiting = views.slice(sentAt, acceptedAt)
    expect(waiting.some((view) => view.stopLive && view.cards === 2)).toBe(true)
    expect(views.slice(sentAt).filter((view) => view.header)).toEqual([])
    expect(views.flatMap((view) => view.steers)).not.toContain(false)
  })

  it('Steer on a held card: the paused row goes from the press until its turn is accepted, then the rest follow', async () => {
    const { first, second, views } = await heldIdleQueue()
    const pressedAt = views.length
    expect(await rig.sendNow(second)).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(second))?.handedOverAt).toBeDefined())
    expect((await published()).queuePause).toBeNull()
    await rig.settleAccepted(await rig.handoffId(second), 'second')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(views.slice(pressedAt).filter((view) => view.header)).toEqual([])
  })

  it('a Steer the agent refuses lifts nothing: the paused row comes back over the card before it', async () => {
    const { first, second, views } = await heldIdleQueue()
    expect(await rig.sendNow(second)).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(second))?.handedOverAt).toBeDefined())
    await eventually(() => expect(views.at(-1)?.header).toBe(false))
    await rig.settleRejected(await rig.handoffId(second), 'turn/start refused')
    await eventually(() => expect(views.at(-1)?.header).toBe(true))
    expect((await published()).queuePause).toEqual({ reason: 'stopped' })
    expect(await rig.handoff(first)).toBeUndefined()
  })

  it('a send the agent refuses lifts nothing: the paused row comes back over the held cards', async () => {
    const { first, views } = await heldIdleQueue()
    const message = composerSend('refused')
    await message.result
    await eventually(async () =>
      expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    )
    await eventually(() => expect(views.at(-1)?.header).toBe(false))
    await rig.settleRejected(message.id, 'turn/start refused')
    await eventually(() => expect(views.at(-1)).toMatchObject({ header: true, cards: 2 }))
    expect(await rig.handoff(first)).toBeUndefined()
  })
})

describe("the queue's next card on a history page", () => {
  it('names the card a Resume released while the drain still waits for the session', async () => {
    const working = await rig.workingSend()
    const card = await queuedDraft('held, then released')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    // Commit Resume while holding its remaining work and the drain behind it.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const write = AgentSessionJournal.prototype.appendQueueResume
    const resume = vi
      .spyOn(AgentSessionJournal.prototype, 'appendQueueResume')
      .mockImplementationOnce(async function (this: AgentSessionJournal, fence: number) {
        const cursor = await write.call(this, fence)
        await held
        return cursor
      })
    const resumed = rig.resume()
    try {
      await eventually(async () => {
        const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
        expect(page.ok && page.page.nextQueuedMessageId).toBe(card)
      })
    } finally {
      release()
      resume.mockRestore()
    }
    expect(await resumed).toMatchObject({ ok: true, value: { resumed: true } })
  })
})

describe('where the host would refuse the send', () => {
  async function cardAddedAfterClear() {
    await rig.settleAccepted(await rig.workingSend(), 'a')
    const fields = { command: 'clear' as const }
    const cleared = await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
    expect(cleared).toMatchObject({ ok: true })
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    // Hold delivery after clear while reading the gate; install the barrier before queuing the task.
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const held = rig.host.collaboratorsForTests().serialize(HOST_TEST_SESSION, () => gate)
    const card = 'left-behind'
    await journal.queuedMessages.insert({
      messageId: card,
      body: hostTestMessage('queued after clear')
    })
    const record = rig.store.getRecord(HOST_TEST_SESSION)
    if (!record) {
      throw new Error('expected the record')
    }
    const done = async (): Promise<void> => {
      release()
      await held
    }
    return { card, journal, record, fence: record.lease.runtimeFence, done }
  }

  it('a card queued after clear is sendable with the completed clear record still present', async () => {
    const { card, journal, record, fence, done } = await cardAddedAfterClear()
    const gate = structuredQueueSendGate(
      { store: rig.store, sessions: rig.host.collaboratorsForTests().sessions },
      HOST_TEST_SESSION
    )
    expect(readQueuePublication(journal, gate).nextQueuedMessageId).toBe(card)
    const { conversationCommand: _cleared, ...unblocked } = record
    const next = readQueuePublication(journal, () => ({
      record: unblocked,
      work: new StructuredAgentSessionCurrentWork(journal, fence)
    }))
    expect(next.nextQueuedMessageId).toBe(card)
    await done()
    await vi.waitFor(() => expect(journal.queuedMessages.get(card)?.state).toBe('dispatched'))
  })

  it('a rewind whose outcome is unknown names no next card', async () => {
    const { journal, record, fence, done } = await cardAddedAfterClear()
    const { conversationCommand: _cleared, ...unblocked } = record
    const rewind = {
      operationId: hostTestOperationId(),
      callerKey: QUEUED_RIG_CALLER.callerKey,
      itemId: 'item-1',
      expectedEpoch: 'epoch-1',
      phase: 'prepared' as const,
      retained: []
    }
    const next = (gateRecord: typeof record) =>
      readQueuePublication(journal, () => ({
        record: gateRecord,
        work: new StructuredAgentSessionCurrentWork(journal, fence)
      })).nextQueuedMessageId
    expect(next({ ...unblocked, rewind })).toBeNull()
    expect(next({ ...unblocked, rewind: { ...rewind, phase: 'provider-succeeded' } })).toBeNull()
    expect(next({ ...unblocked, rewind: { ...rewind, phase: 'completed' } })).not.toBeNull()
    await done()
  })
})
