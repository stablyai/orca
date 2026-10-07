// A send asking to be queued while a person's Stop ends the work is a card at the END of the queue
// at once, written beside the session's lane, which that Stop holds until its provider answers.
// The Stop's pause holds it, even alone, until Resume or a turn accepted after the Stop;
// orchestration mail is the exception, running as the stop lands. Through the real host and journal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
}

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
})

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

/** The provider's row for the working send's turn. */
function turnRow(state: 'running' | 'interrupted') {
  return journal().appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 999 },
    { kind: 'turn', turnId: 'turn-1', state, startedAt: 1 },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** A send whose turn runs until the Stop `stop` presses lands. */
async function runningTurn(): Promise<string> {
  const working = await rig.workingSend()
  await turnRow('running')
  return working
}

/** A person's Stop of the running turn: the chat reads Stopping until the returned land ends it. */
async function stop(working: string): Promise<() => Promise<void>> {
  expect(await rig.stop()).toMatchObject({ ok: true })
  expect(readStopping()).toBe(true)
  return async () => {
    await rig.settleAccepted(working, 'stopped')
    await turnRow('interrupted')
    expect(readStopping()).toBe(false)
  }
}

function readStopping(): boolean {
  return rig.host['clientDelivery'].readStopping(SESSION)
}

/** Holds the session's lane until released: a send that answers meanwhile never waited on it. */
function holdLane(): () => void {
  const held = Promise.withResolvers<void>()
  void rig.host['tasks'].serialize(SESSION, () => held.promise)
  return () => held.resolve()
}

async function queuedId(sent: ReturnType<QueuedMessageTestRig['send']>['result']): Promise<string> {
  const queued = await sent
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error(`expected a queued receipt: ${JSON.stringify(queued)}`)
  }
  return queued.value.queued.messageId
}

/** Nothing sends any of them by itself, and the queue reads paused by the Stop. */
async function expectHeld(...draftIds: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
}

/** The next admission waits until released, once it has read the journal it will write to. */
function holdNextAdmission(): { reached: Promise<void>; release: () => void } {
  const reached = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const admit = rig.store.admitMutationOperation.bind(rig.store)
  vi.spyOn(rig.store, 'admitMutationOperation').mockImplementationOnce(async (operation) => {
    reached.resolve()
    await gate.promise
    return admit(operation)
  })
  return { reached: reached.promise, release: () => gate.resolve() }
}

describe('a queued send while Stopping', () => {
  it('is a card at once, at the end, with the lane held; Resume sends the cards in order', async () => {
    const working = await runningTurn()
    const before = await queuedId(rig.send('queued before the stop', 'queue-if-active').result)
    const land = await stop(working)
    const release = holdLane()

    const during = await queuedId(rig.send('sent while stopping', 'queue-if-active').result)

    release()
    expect(await rig.drafts()).toEqual([
      { messageId: before, state: 'waiting' },
      { messageId: during, state: 'waiting' }
    ])
    await land()
    await expectHeld(before, during)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect((await rig.handoff(before))?.handedOverAt).toBeDefined())
    expect(await rig.handoff(during)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(before), 'before')
    await eventually(async () => expect(await rig.handoff(during)).toBeDefined())
  })

  it('alone, waits too; a turn sent and accepted after the Stop releases it after that turn', async () => {
    const land = await stop(await runningTurn())
    const alone = await queuedId(rig.send('sent while stopping', 'queue-if-active').result)
    await land()
    await expectHeld(alone)
    // What "Send message" does: a plain send, past the card, that ends the pause once accepted.
    const next = rig.send('sent now')
    expect(await next.result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    await eventually(async () =>
      expect((await rig.submission(next.id))?.handedOverAt).toBeDefined()
    )
    expect(await rig.handoff(alone)).toBeUndefined()
    await rig.settleAccepted(next.id, 'next')
    await eventually(async () => expect(await rig.handoff(alone)).toBeDefined())
  })
})

// Mail never waits on a person's Resume: queued while Stopping it runs as the stop lands, ahead of
// the person's cards, and its accepted turn lifts the pause so they follow in order.
describe('orchestration mail sent while Stopping', () => {
  it("is a card at the end the person's Stop does not hold: it runs first, then the cards follow", async () => {
    const working = await runningTurn()
    const person = await queuedId(rig.send('queued before the stop', 'queue-if-active').result)
    const land = await stop(working)
    const mail = await queuedId(
      rig.send('mail sent while stopping', 'queue-if-active', { internal: true, from: MAIL }).result
    )
    const typed = await queuedId(rig.send('typed while stopping', 'queue-if-active').result)
    expect((await rig.drafts()).map((draft) => draft.messageId)).toEqual([person, mail, typed])
    // Only the mail's body names a sender, so a client labels it as waiting, not paused.
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(
      page.ok && page.page.queuedMessages?.map((card) => card.body.from !== undefined)
    ).toEqual([false, true, false])

    await land()
    await eventually(async () => expect((await rig.handoff(mail))?.handedOverAt).toBeDefined())
    expect(await rig.handoff(person)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(mail), 'mail')
    await eventually(async () => expect((await rig.handoff(person))?.handedOverAt).toBeDefined())
    expect(await rig.handoff(typed)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(person), 'person')
    await eventually(async () => expect(await rig.handoff(typed)).toBeDefined())
  })
})

describe('the card written beside the lane', () => {
  // Read once, before admission: a stop that lands meanwhile still gets the card, held, and never
  // a fallback onto the lane.
  it('is still a held card at the end when the stop lands between the read and the write', async () => {
    const working = await runningTurn()
    const before = await queuedId(rig.send('queued before the stop', 'queue-if-active').result)
    const land = await stop(working)
    const admission = holdNextAdmission()
    const sent = rig.send('sent as the stop lands', 'queue-if-active')
    await admission.reached
    await land()
    admission.release()

    const during = await queuedId(sent.result)
    expect(await rig.drafts()).toEqual([
      { messageId: before, state: 'waiting' },
      { messageId: during, state: 'waiting' }
    ])
    expect(await rig.submission(sent.id)).toBeUndefined()
    await expectHeld(before, during)
  })

  it('writes nothing when the conversation closes meanwhile; the operation stays pending and a resend answers once', async () => {
    const land = await stop(await runningTurn())
    const admission = holdNextAdmission()
    const clientOperationId = hostTestOperationId()
    const fields = { body: hostTestMessage('sent as the chat closes'), delivery: 'queue-if-active' }
    const resend = () =>
      rig.host.send(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.send', clientOperationId),
        body: fields.body,
        delivery: 'queue-if-active'
      })
    const sent = resend()
    await admission.reached
    await land()
    await rig.host.close(SESSION, 'evict')
    admission.release()

    await expect(sent).rejects.toMatchObject({ code: 'journal_closed' })
    expect(rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, clientOperationId)).toMatchObject(
      { outcome: { status: 'pending' } }
    )
    // The chat reopens idle: the resend runs for the first time, once.
    const first = await resend()
    expect(first).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(await resend()).toMatchObject({
      ok: true,
      replayed: true,
      value: first.ok ? first.value : {}
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('refuses as the lane does when the conversation is cleared meanwhile', async () => {
    await stop(await runningTurn())
    const admission = holdNextAdmission()
    const sent = rig.send('sent as the chat clears', 'queue-if-active')
    await admission.reached
    const getRecord = rig.store.getRecord.bind(rig.store)
    vi.spyOn(rig.store, 'getRecord').mockImplementation((sessionId): AgentSessionRecord | null => {
      const record = getRecord(sessionId)
      return (
        record && {
          ...record,
          conversationCommand: {
            command: 'clear',
            runtimeFence: 1,
            operationId: 'clear-1',
            callerKey: QUEUED_RIG_CALLER.callerKey,
            phase: 'committed',
            state: 'completed',
            replacementSessionId: 'clear-replacement-1'
          }
        }
      )
    })
    admission.release()

    expect(await sent.result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCleared' } }
    })
    vi.mocked(rig.store.getRecord).mockRestore()
    expect(await rig.drafts()).toEqual([])
  })
})
