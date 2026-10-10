// The queue sends its cards strictly in order. The host publishes the queue's pause and the card it
// sends next. A client reading its updates one at a time, as the chat does, reads one working state
// across a turn's end or a Resume and the queue's send of the next card: the working status and
// row, the pickers, the composer button and the card labels never flip in between. After a restart
// nothing sends by itself and no pause shows: the chat's next turn runs first, then the cards.
// Where the host would refuse the send, it names no next card, so the chat reads idle.

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
import {
  nativeChatComposerPrimaryAction,
  type NativeChatComposerPrimaryAction
} from '../../../renderer/src/components/native-chat/native-chat-composer-primary-action'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'
import {
  structuredAgentSessionHostInstance,
  structuredQueuePauses
} from './structured-agent-session-queued-pause'
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

let rig: QueuedMessageTestRig

const MANUAL_IDLE_SWEEP = { idleMs: 0, intervalMs: 60 * 60 * 1000 }

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** What a reader opening the chat now is told: the queue's pause and the card it sends next. */
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

/** The pauses in force, published or not: a restart's is never published. */
function derivedPauses(): string[] {
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  return structuredQueuePauses(journal).map((pause) => pause.reason)
}

/** Lets the drain run its steps; none may hand a card off. */
async function expectNothingSent(...draftIds: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
}

type ClientView = {
  /** The chat reads as working: transcript status, working row and timer, the pickers. */
  working: boolean
  /** A Stop pressed now would stop something. */
  stopLive: boolean
  /** The empty composer's primary button. */
  button: NativeChatComposerPrimaryAction
  /** The header row above the cards: the queue is held. */
  header: boolean
  /** A new message first asks whether to clear the cards ("Send message?"). */
  dialog: boolean
  /** Each card's Send-now reads Steer. */
  steers: boolean[]
  /** Why each card waits, which picks its caption: 'turn' is a plain waiting card. */
  holds: string[]
  cards: number
  nextQueuedMessageId: string | null
}

/** A composer message: sent with the composer's queue delivery. */
function composerSend(text: string): ReturnType<QueuedMessageTestRig['send']> {
  return rig.send(text, 'queue-if-active')
}

/** Folds every published update as the chat does, one at a time, into what it shows. */
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
      // As use-structured-agent-session.ts derives it.
      const working = hostWorking || (nextQueuedMessageId !== null && !hostWorking)
      const cards = projectQueuedMessageCards(queued, all, { queuePaused: queuePause !== null })
      // As use-structured-agent-session-queued-messages.ts derives them.
      const header = queuedMessagesQueuePause(cards, queuePause) !== null
      const queueHeld = header && !working
      views.push({
        working,
        stopLive: hostWorking,
        button: nativeChatComposerPrimaryAction({
          isWorking: working,
          composerEmpty: true,
          queueHeld
        }),
        header,
        dialog: queueHeld,
        steers: cards.map((card) => queuedMessageCardSteers(card)),
        holds: cards.map((card) => card.hold),
        cards: cards.length,
        nextQueuedMessageId
      })
    }
  })
  return views
}

/** Every update in the run reads working, with Stop and Steer, and the gap update is among them. */
function expectOneWorkingRun(views: readonly ClientView[]): void {
  expect(views.filter((view) => !view.working || view.button !== 'stop')).toEqual([])
  expect(views.flatMap((view) => view.steers)).not.toContain(false)
  // Between a turn's end (or a Resume) and the queue's send: nothing in flight yet, still working.
  expect(views.some((view) => !view.stopLive && view.nextQueuedMessageId !== null)).toBe(true)
}

describe('a Stop holds the queue, in order', () => {
  it('a card typed while the Stop lands waits behind the held one; Resume sends both in order, with no Resume or Send between them', async () => {
    const working = await rig.workingSend()
    const held = await queuedDraft('held by the stop')
    await rig.stop()
    const typed = await queuedDraft('typed while the stop lands')
    const views = await watchClient()
    // Still winding down: the paused row shows, but neither Resume nor "Send message?" while it runs.
    expect(views.at(-1)).toMatchObject({ working: true, header: true, dialog: false })
    await rig.settleAccepted(working, 'stopped')
    await eventually(() => expect(views.at(-1)).toMatchObject({ header: true, dialog: true }))
    expect(views.at(-1)?.button).toBe('resume')
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

  it('after Resume over held cards the chat goes from idle with Resume straight to working with Stop', async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    await queuedDraft('second')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const views = await watchClient()
    const before = views.length
    expect(views.at(-1)).toMatchObject({ working: false, button: 'resume' })
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    await eventually(() => expect(views.at(-1)?.stopLive).toBe(true))
    expectOneWorkingRun(views.slice(before))
  })
})

describe('after a restart, nothing sends by itself', () => {
  /** A turn runs with cards A and B waiting, and Orca quits: a quit writes no Stop event. */
  async function restartedWithCards(): Promise<{ first: string; second: string }> {
    await rig.workingSend()
    const first = await queuedDraft('A')
    const second = await queuedDraft('B')
    rig.crashRestartHostProcess()
    // The new host opens the chat for its first reader.
    await published()
    return { first, second }
  }

  /** The same, through a restart whose old agent this rig can still settle, so the next turn can
   *  reach the agent: the turn that ran ends before anything new is sent. */
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
    // Closed and opened again (the idle sweep, a reconnect): the same.
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
    await expectNothingSent(first, second)
    // The chat reads idle with plain cards: no paused row, no Resume, no "Send message?".
    expect(views.at(-1)).toMatchObject({
      working: false,
      header: false,
      dialog: false,
      button: 'send',
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
    // The restart prompt's Resume sends the carry-on as Orca's own message, straight to the agent.
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
    expect(views.filter((view) => view.header || view.dialog)).toEqual([])
    expectOneWorkingRun(views.slice(views.findIndex((view) => view.working)))
  })

  it("the person's own message goes straight to the agent first, then A, then B", async () => {
    const { first, second } = await restartedIdleWithCards()
    const views = await watchClient()
    // Sent with the composer's queue delivery: nothing ahead may send, so it is not queued.
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
    expect(views.filter((view) => view.header || view.dialog)).toEqual([])
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
    expect(views.at(-1)).toMatchObject({ header: false, dialog: false, button: 'send' })
    const carryOn = rig.send('continue where you left off')
    await carryOn.result
    await expectNothingSent(first, second)
    await rig.settleAccepted(carryOn.id, 'carry-on')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(await rig.handoff(second)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(first), 'A')
    await eventually(async () => expect(await rig.handoff(second)).toBeDefined())
    expect(views.filter((view) => view.header || view.dialog)).toEqual([])
  })

  it('a card written after the restart waits while any card from before it waits; then it is an ordinary queue', async () => {
    const { first, second } = await restartedIdleWithCards()
    // Your message goes straight to the agent; while it waits, the next one queues.
    const message = rig.send('a new instruction')
    await message.result
    await eventually(async () =>
      expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    )
    const typed = await queuedDraft('typed while it waits')
    // The agent refuses it: no turn started, so every card waits, the new one included.
    await rig.settleRejected(message.id, 'turn/start refused')
    await expectNothingSent(first, second, typed)
    expect(derivedPauses()).toEqual(['restarted'])
    expect(await published()).toEqual({ queuePause: null, nextQueuedMessageId: null })
    expect(await rig.deleteQueued(first)).toMatchObject({ ok: true, value: { deleted: true } })
    await expectNothingSent(second, typed)
    // With nothing from before the restart left, the card sends like any queued card.
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
    // The agent at rest goes; Resume's hand-off of A must start a new one, which never starts.
    await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
    // The hand-off is recorded, never handed over: the new child stays in its spawn.
    const release = rig.holdNextStart()
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    const cutShort = await rig.handoffId(first)
    expect((await rig.handoff(first))?.handedOverAt).toBeUndefined()
    rig.crashRestartHostProcess()
    release()
    await published()
    // The new host refuses the leftover hand-off, and A waits again in its own place.
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
    // A turn happened in this chat before, so the new epoch restates a lift.
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

describe("a message sent over a held queue (the confirmation's Send message)", () => {
  /** Two cards a Stop holds, the stopped turn over: the paused row and Resume show. */
  async function heldIdleQueue() {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    const second = await queuedDraft('second')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const views = await watchClient()
    expect(views.at(-1)).toMatchObject({ header: true, button: 'resume', dialog: true, cards: 2 })
    return { first, second, views }
  }

  it('goes out at once: the paused row goes as it is sent and never comes back, and the held cards follow it in order', async () => {
    const { first, second, views } = await heldIdleQueue()
    // Sent with the composer's queue delivery: no card ahead may send, so nothing queues it.
    const message = composerSend('a new instruction')
    const sentAt = views.length
    expect(await message.result).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    // The cards stay held until the agent accepts the message's turn, but the host no longer says
    // paused: that turn is on its way to lift it.
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
    // Updates arrived while the message waited for the agent, with both cards still held.
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
    expect(views.slice(pressedAt).filter((view) => view.header || view.dialog)).toEqual([])
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
    // The Resume row is written; the Resume itself, and so the drain behind it, waits.
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
  /** A new card in the same conversation after /clear inherits no earlier pause. */
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
    const card = 'left-behind'
    await journal.queuedMessages.insert({
      messageId: card,
      body: hostTestMessage('queued after clear'),
      fingerprint: 'fp-left-behind',
      hostInstance: structuredAgentSessionHostInstance()
    })
    const record = rig.store.getRecord(HOST_TEST_SESSION)
    if (!record) {
      throw new Error('expected the record')
    }
    return { card, journal, record, fence: record.lease.runtimeFence }
  }

  it('a card queued after clear is sendable with the completed clear record still present', async () => {
    const { card, journal, record, fence } = await cardAddedAfterClear()
    const gate = structuredQueueSendGate(rig.store, HOST_TEST_SESSION)
    expect(readQueuePublication(journal, gate).nextQueuedMessageId).toBe(card)
    const { conversationCommand: _cleared, ...unblocked } = record
    const next = readQueuePublication(journal, () => ({ record: unblocked, fence }))
    expect(next.nextQueuedMessageId).toBe(card)
  })

  it('a rewind whose outcome is unknown names no next card', async () => {
    const { journal, record, fence } = await cardAddedAfterClear()
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
      readQueuePublication(journal, () => ({ record: gateRecord, fence })).nextQueuedMessageId
    expect(next({ ...unblocked, rewind })).toBeNull()
    expect(next({ ...unblocked, rewind: { ...rewind, phase: 'provider-succeeded' } })).toBeNull()
    expect(next({ ...unblocked, rewind: { ...rewind, phase: 'completed' } })).not.toBeNull()
  })
})
