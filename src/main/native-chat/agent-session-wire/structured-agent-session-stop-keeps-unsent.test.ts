// A person's Stop settles a message the host still holds as a close does: the agent never got it,
// so the person's words come back as a card at the head of the queue, held by the Stop's pause,
// and the conversation shows no bubble for them. Against the real host, store and journal, with
// an agent that stays starting until the test proves its start.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { holdDelivery } from './structured-agent-session-delivery-hold.test-fixture'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

const CANCELLED = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
  surface: 'rejection'
})
/** A kept send: an ordinary waiting card, with no hold of its own. */
const KEPT = { state: 'waiting' }

/** Orchestration mail as the mailbox sends it: from another agent, naming its sender. */
const MAIL_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'agent:coordinator', terminalHandle: null, orcaSessionId: null },
      name: null
    }
  ],
  orchestration: { message: 'mail-notice', mailbox: 'agent:worker', dispatchId: null, messages: [] }
}

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, starting: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
})

function journal(): AgentSessionJournal {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('the conversation is not open')
  }
  return open
}

function dispatchedTexts(): string[] {
  return rig.dispatch.mock.calls.map(([input]) =>
    input.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
  )
}

/** The exact request a client sends, so a test can send the same one again. */
function sendRequest(text: string) {
  const body = hostTestMessage(text)
  return {
    envelope: rig.envelope({ body }, 'agentSession.send', hostTestOperationId()),
    body,
    userSend: true as const
  }
}

/** Sent while the agent starts, and held: none is handed over. */
async function heldWhileStarting(...requests: ReturnType<typeof sendRequest>[]): Promise<string[]> {
  // No child, so the first send starts one, which stays starting.
  await rig.host.close(SESSION, 'evict')
  const ids: string[] = []
  for (const request of requests) {
    expect(await rig.host.send(QUEUED_RIG_CALLER, request)).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending', handoverRecorded: true } }
    })
    ids.push(request.envelope.clientOperationId)
  }
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )
  for (const id of ids) {
    expect((await rig.submission(id))?.handedOverAt).toBeUndefined()
  }
  return ids
}

async function queuedCard(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** The texts a client's transcript draws, desktop (`rejectedInPlace`) or phone. */
async function transcriptTexts(rejectedInPlace: boolean): Promise<string[]> {
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return projectStructuredAgentSessionMessages(page.page.items, [], page.page.submissions, {
    rejectedInPlace
  }).map(
    (message) =>
      `${message.blocks.map((block) => ('text' in block ? block.text : '')).join('')}${
        message.stoppedBeforeStart ? ' (stopped)' : ''
      }`
  )
}

async function stopKeepsBoth(): Promise<[string, string]> {
  const [first, second] = await heldWhileStarting(sendRequest('first'), sendRequest('second'))
  expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
  await eventually(async () =>
    expect(await rig.drafts()).toEqual([
      { messageId: first, ...KEPT },
      { messageId: second, ...KEPT }
    ])
  )
  return [first!, second!]
}

describe('a Stop while the agent starts, with two messages held', () => {
  it('keeps both as cards at the head of the queue, held by the Stop, with no bubble and no write', async () => {
    const [first, second] = await heldWhileStarting(sendRequest('first'), sendRequest('second'))
    // A card queued while the start held them stands behind them.
    const queued = rig.send('queued behind the start', 'queue-if-active')
    expect(await queued.result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    await eventually(async () =>
      expect(await rig.drafts()).toEqual([
        { messageId: first, ...KEPT },
        { messageId: second, ...KEPT },
        { messageId: queued.id, state: 'waiting' }
      ])
    )
    expect(rig.dispatch).not.toHaveBeenCalled()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    for (const [id, text] of [
      [first, 'first'],
      [second, 'second']
    ] as const) {
      expect(await rig.submission(id!)).toMatchObject({
        dispatchState: 'rejected',
        ...CANCELLED,
        keptAsQueuedMessageId: id
      })
      expect(journal().queuedMessages.get(id!)).toMatchObject({
        holdReason: null,
        body: hostTestMessage(text)
      })
    }
    // The card is the only surface: neither client draws a bubble or a stop row for them.
    expect(await transcriptTexts(true)).toEqual([])
    expect(await transcriptTexts(false)).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rig.dispatch).not.toHaveBeenCalled()
  })

  it('Resume sends them in order, each exactly once', async () => {
    const [first, second] = await stopKeepsBoth()

    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await rig.proveStart()
    await eventually(() => expect(dispatchedTexts()).toEqual(['first']))
    await rig.settleAccepted(await rig.handoffId(first), 'first')
    await eventually(() => expect(dispatchedTexts()).toEqual(['first', 'second']))
    await rig.settleAccepted(await rig.handoffId(second), 'second')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dispatchedTexts()).toEqual(['first', 'second'])
    expect(await rig.drafts()).toEqual([])
  })

  it("the person's next message sends first; its accepted turn lifts the pause, then the cards drain once, in order", async () => {
    const [first, second] = await stopKeepsBoth()

    const next = rig.send('what was the last message I sent?')
    await next.result
    await rig.proveStart()
    await eventually(() => expect(dispatchedTexts()).toEqual(['what was the last message I sent?']))
    expect(await rig.handoff(first)).toBeUndefined()
    await rig.settleAccepted(next.id, 'next')
    await eventually(() =>
      expect(dispatchedTexts()).toEqual(['what was the last message I sent?', 'first'])
    )
    await rig.settleAccepted(await rig.handoffId(first), 'first')
    await eventually(() =>
      expect(dispatchedTexts()).toEqual(['what was the last message I sent?', 'first', 'second'])
    )
    await rig.settleAccepted(await rig.handoffId(second), 'second')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dispatchedTexts()).toHaveLength(3)
  })

  it('a same-id Retry of a kept send replays its receipt and writes nothing to the agent', async () => {
    const request = sendRequest('sent again')
    const [id] = await heldWhileStarting(request)
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(async () => expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }]))
    const submissionsBefore = (await rig.host.journalSnapshot(SESSION)).submissions.length

    expect(await rig.host.send(QUEUED_RIG_CALLER, request)).toMatchObject({
      ok: true,
      replayed: true,
      value: {
        clientMessageId: id,
        submission: { dispatchState: 'rejected', ...CANCELLED, keptAsQueuedMessageId: id }
      }
    })
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toHaveLength(submissionsBefore)
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rig.dispatch).not.toHaveBeenCalled()
  })
})

describe('the kept cards afterwards', () => {
  it('a host restart keeps them, held, and sends nothing', async () => {
    const [first, second] = await stopKeepsBoth()

    rig.crashRestartHostProcess()

    expect(await rig.drafts()).toEqual([
      { messageId: first, ...KEPT },
      { messageId: second, ...KEPT }
    ])
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toContain('restarted')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rig.dispatch).not.toHaveBeenCalled()
  })

  it('/clear carries them under its own pause', async () => {
    const [first, second] = await stopKeepsBoth()
    const fields = { command: 'clear' as const }

    expect(
      await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })

    expect(await rig.drafts()).toEqual([
      { messageId: first, ...KEPT },
      { messageId: second, ...KEPT }
    ])
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toContain('cleared')
    expect(rig.dispatch).not.toHaveBeenCalled()
  })

  it("a rewind's new epoch restates the Stop's pause over them", async () => {
    const [first, second] = await stopKeepsBoth()

    await journal().replaceEpochItems(
      'handle_forked',
      rig.store.getRecord(SESSION)!.lease.runtimeFence,
      []
    )

    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toEqual(['stopped'])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.drafts()).toEqual([
      { messageId: first, ...KEPT },
      { messageId: second, ...KEPT }
    ])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rig.dispatch).not.toHaveBeenCalled()
  })
})

describe('what a Stop does not keep', () => {
  it('orchestration mail held behind the start is rejected as before, with no card', async () => {
    await rig.host.close(SESSION, 'evict')
    const mail = rig.send('mail notice', undefined, { internal: true, from: MAIL_SOURCE })
    await mail.result
    await eventually(() =>
      expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
    )

    expect(await rig.stop()).toMatchObject({ ok: true })

    await eventually(async () =>
      expect(await rig.submission(mail.id)).toMatchObject({
        dispatchState: 'rejected',
        ...CANCELLED
      })
    )
    expect(await rig.submission(mail.id)).not.toHaveProperty('keptAsQueuedMessageId')
    expect(await rig.drafts()).toEqual([])
  })

  it("a card's own hand-off is returned to its place under the pause, and makes no second card", async () => {
    const working = await rig.workingSend()
    const card = await queuedCard('a queued card')
    const behind = await queuedCard('behind it')
    // The turn ends and the drain hands the card off; its delivery is held, so it is not handed over.
    const { release } = holdDelivery()
    await rig.settleAccepted(working, 'working')
    await eventually(async () => expect(await rig.handoff(card)).toBeDefined())
    const handoffId = await rig.handoffId(card)
    expect((await rig.submission(handoffId))?.handedOverAt).toBeUndefined()

    const stopped = rig.stop()
    release()
    expect(await stopped).toMatchObject({ ok: true })

    expect(await rig.submission(handoffId)).toMatchObject({
      dispatchState: 'rejected',
      ...CANCELLED
    })
    expect(await rig.submission(handoffId)).not.toHaveProperty('keptAsQueuedMessageId')
    expect(await rig.drafts()).toEqual([
      { messageId: card, state: 'waiting' },
      { messageId: behind, state: 'waiting' }
    ])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it('a Send now cut short by the Stop returns its card where it stood', async () => {
    const working = await rig.workingSend()
    const first = await queuedCard('first card')
    const pushed = await queuedCard('pushed ahead')
    const drain = holdDelivery()
    await rig.settleAccepted(working, 'working')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    const stopped = rig.stop()
    drain.release()
    await stopped
    // Send now on the second card; its hand-off is held, then a Stop takes it back.
    const send = holdDelivery()
    expect(await rig.sendNow(pushed)).toMatchObject({ ok: true })
    await eventually(async () => expect(await rig.handoff(pushed)).toBeDefined())
    expect((await rig.handoff(pushed))?.handedOverAt).toBeUndefined()
    const again = rig.stop()
    send.release()
    expect(await again).toMatchObject({ ok: true })

    expect(await rig.handoff(pushed)).toMatchObject({ dispatchState: 'rejected', origin: 'client' })
    expect(await rig.drafts()).toEqual([
      { messageId: first, state: 'waiting' },
      { messageId: pushed, state: 'waiting' }
    ])
  })

  it('a Stop with nothing held changes nothing and writes no Stop', async () => {
    // An idle chat: no agent runs and nothing is queued.
    await rig.host.close(SESSION, 'evict')
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(journal().stopMarks.latest()).toBeNull()
    expect(await rig.drafts()).toEqual([])
    expect(await rig.queuePause()).toBeNull()
  })
})

describe('a card that cannot be written', () => {
  it('falls back to the rejection, and the Stop still completes and is written', async () => {
    const [id] = await heldWhileStarting(sendRequest('card write fails'))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(JournalQueuedMessages.prototype, 'holdInTransaction').mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    await eventually(async () =>
      expect(await rig.submission(id!)).toMatchObject({ dispatchState: 'rejected', ...CANCELLED })
    )
    expect(await rig.submission(id!)).not.toHaveProperty('keptAsQueuedMessageId')
    expect(await rig.drafts()).toEqual([])
    expect(journal().stopMarks.latest()?.event.reason).toBe('user-stop')
    expect(warned).toHaveBeenCalledWith(
      '[journal-hold] keeping an unsent send failed:',
      expect.objectContaining({ clientMessageId: id, cause: 'cancelled' })
    )
    expect(rig.dispatch).not.toHaveBeenCalled()
  })
})

describe('a start that never answered, ended by the Stop', () => {
  it("keeps a person's message the child was handed and never ran as a card", async () => {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({
      restartable: true,
      starting: true,
      startUnanswered: true,
      stopEndsSession: true
    })
    const [id] = await heldWhileStarting(sendRequest('handed to a start that never answered'))
    // Handed to the child before its start answered, as a build before held sends did.
    await journal().resolveDispatch({
      clientMessageId: id!,
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      fence: rig.store.getRecord(SESSION)!.lease.runtimeFence
    })
    expect((await rig.submission(id!))?.handedOverAt).toBeDefined()

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    await eventually(async () =>
      expect(await rig.submission(id!)).toMatchObject({
        dispatchState: 'rejected',
        ...CANCELLED,
        keptAsQueuedMessageId: id
      })
    )
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toEqual(['stopped'])
    expect(await transcriptTexts(true)).toEqual([])
  })
})
