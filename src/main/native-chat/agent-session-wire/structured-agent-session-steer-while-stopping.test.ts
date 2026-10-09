// Nothing steers into a turn a person's Stop is ending: a card's Send-now or a send made then waits
// behind the Stop's end of the child, and runs after it as its own turn on the child that resumes
// the chat. The host owns the rule, so a client of any version gets it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { holdDelivery } from './structured-agent-session-delivery-hold.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

async function turn(turnId: string, clientMessageId: string, state: 'running' | 'interrupted') {
  await journal().appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 999 },
    {
      kind: 'turn',
      turnId,
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(clientMessageId),
      ...(state === 'running' ? { state } : { state, completedAt: Date.now() + 5 })
    },
    {
      fence: rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

function watchStatus(): () => AgentSessionStatusSummary | undefined {
  const events: AgentSessionStatusEvent[] = []
  rig.host.subscribeStatus({ id: 'list', emit: (event) => events.push(event) })
  return () => {
    for (const event of events.toReversed()) {
      if (event.type === 'status' && event.session.sessionId === HOST_TEST_SESSION) {
        return event.session
      }
      if (event.type === 'snapshot') {
        return event.sessions.find((session) => session.sessionId === HOST_TEST_SESSION)
      }
    }
    return undefined
  }
}

/** The session's lane, after every step queued on it so far, the delivery loop's included. */
async function laneDrained(): Promise<void> {
  for (let step = 0; step < 5; step += 1) {
    await rig.host['tasks'].serialize(HOST_TEST_SESSION, async () => {})
  }
}

/** The child the Stop ends is handed nothing more; what follows runs on the child that resumes. */
function expectRanOnResumedChild(dispatched: number): void {
  expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1)
  expect(rig.closeSession).toHaveBeenCalledOnce()
  expect(rig.closeSession.mock.invocationCallOrder[0]).toBeLessThan(
    rig.dispatch.mock.invocationCallOrder.at(-1) ?? 0
  )
  expect(rig.dispatch.mock.calls.at(-1)?.[0].fence).toBeGreaterThan(1)
}

/** Holds the child's end the Stop's next step asks for, until `endChild`. */
function holdChildEnd(): () => void {
  const kill = Promise.withResolvers<boolean>()
  rig.closeSession.mockImplementationOnce(() => kill.promise)
  return () => kill.resolve(true)
}

/** Turn `turn-1` running, a person's Stop ending it with its end of the child held, and what was
 *  dispatched by then. */
async function stoppingTurn(options: { card?: true; refused?: true } = {}) {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const sent = await rig.workingSend()
  await rig.settleAccepted(sent, 'sent')
  await turn('turn-1', sent, 'running')
  const status = watchStatus()
  let cardId: string | undefined
  if (options.card) {
    await rig.send('queued card', 'queue-if-active').result
    await eventually(async () => expect(await rig.drafts()).toHaveLength(1))
    cardId = (await rig.drafts())[0]?.messageId
  }
  if (options.refused) {
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false })
  }
  const endChild = holdChildEnd()
  expect(await rig.stop()).toMatchObject({ ok: true })
  await eventually(() => expect(rig.closeSession).toHaveBeenCalledOnce())
  expect(status()).toMatchObject({ stopping: true })
  return { sent, status, cardId, endChild, dispatched: rig.dispatch.mock.calls.length }
}

describe("a message sent while a person's Stop ends the turn", () => {
  it.each([
    ['a queued card sent now', true, false],
    ['a send', false, false],
    ['a send, after a Stop the agent declined', false, true]
  ])('waits for the child to end, then runs as its own turn: %s', async (_, fromCard, refused) => {
    const { sent, status, cardId, endChild, dispatched } = await stoppingTurn({
      ...(fromCard ? { card: true as const } : {}),
      ...(refused ? { refused: true as const } : {})
    })

    // Held on the session's lane behind the Stop's end of the child.
    const sending = cardId ? rig.sendNow(cardId) : rig.send('one more thing').result
    expect(status()).toMatchObject({ stopping: true })
    await turn('turn-1', sent, 'interrupted')
    expect(rig.dispatch.mock.calls.length).toBe(dispatched)

    endChild()
    const result = await sending
    expect(result).toMatchObject({ ok: true })
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1))
    expectRanOnResumedChild(dispatched)
    expect(rig.dispatch.mock.calls.at(-1)?.[0].clientMessageId).toBe(
      result.ok ? result.value.clientMessageId : ''
    )
  })

  // A Stop pressed before the turn showed, which the agent declined, still ends the child, whose
  // end takes the first send back. A send made while it settles runs on the child that resumes the
  // chat, and Stopping never comes back for its turn.
  it('hands a send made while a declined Stop settles to the resumed child, with no Stopping flip', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const first = await rig.workingSend()
    const seen: (true | undefined)[] = []
    rig.host.subscribeStatus({
      id: 'flips',
      emit: (event) => {
        if (event.type === 'status' && event.session.sessionId === HOST_TEST_SESSION) {
          seen.push(event.session.stopping)
        }
      }
    })
    const answer = Promise.withResolvers<{ cancelled: boolean }>()
    rig.cancelTurn.mockImplementationOnce(() => answer.promise)
    const stopped = rig.stop()
    await eventually(() => expect(seen.at(-1)).toBe(true))
    const dispatched = rig.dispatch.mock.calls.length

    // Accepted on the session's lane behind the Stop and its end of the child.
    const later = rig.send('sent before the turn opened')
    answer.resolve({ cancelled: false })
    expect(await stopped).toMatchObject({ ok: true })
    expect(await later.result).toMatchObject({ ok: true })
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1))
    expectRanOnResumedChild(dispatched)
    expect(await rig.submission(first)).toMatchObject({ dispatchState: 'rejected' })

    await rig.settleAccepted(later.id, 'later')
    await turn('turn-2', later.id, 'running')
    await laneDrained()
    expect(seen.at(-1)).toBeUndefined()
    // Once Stopping ended it never came back.
    expect(seen.slice(seen.lastIndexOf(true) + 1)).not.toContain(true)
  })

  // A settle edge writes no row, so nothing else wakes the handover once it closes.
  it('hands a held send over when the Stop settles with no row after it', async () => {
    rig = await createQueuedMessageTestRig()
    // Working: its turn is open, so the held send is held only by the Stop's settle.
    await turn('turn-1', await rig.workingSend(), 'running')
    await journal().appendStopEvent({ reason: 'user-stop' }, 1)
    const settle = journal().stopMarks.beginSettle()
    const later = rig.send('sent while the Stop settles')
    expect(await later.result).toMatchObject({ ok: true })
    await laneDrained()
    const dispatched = rig.dispatch.mock.calls.length
    expect((await rig.submission(later.id))?.handedOverAt).toBeUndefined()

    journal().stopMarks.settled(settle)

    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1))
  })

  // The delivery step that judged the send and its handover are two turns of the session's lane.
  it('holds a send that a Stop overtook between its delivery step and the handover', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const sent = await rig.workingSend()
    await rig.settleAccepted(sent, 'sent')
    await turn('turn-1', sent, 'running')
    await laneDrained()
    const status = watchStatus()
    const step = holdDelivery()
    const first = rig.send('steer this in')
    expect(await first.result).toMatchObject({ ok: true })
    await step.held
    const dispatched = rig.dispatch.mock.calls.length

    // The Stop withdraws the first send; a second one arrives before the handover.
    const endChild = holdChildEnd()
    const stopped = rig.stop()
    const second = rig.send('and this one')
    step.release()
    expect(await stopped).toMatchObject({ ok: true })
    await eventually(() => expect(rig.closeSession).toHaveBeenCalledOnce())
    expect(status()).toMatchObject({ stopping: true })

    await turn('turn-1', sent, 'interrupted')
    expect(rig.dispatch.mock.calls.length).toBe(dispatched)
    endChild()
    expect(await second.result).toMatchObject({ ok: true })
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1))
    expectRanOnResumedChild(dispatched)
    expect(rig.dispatch.mock.calls.at(-1)?.[0].clientMessageId).toBe(second.id)
    expect(await rig.submission(first.id)).toMatchObject({ dispatchState: 'rejected' })
  })

  // The hold reads the status feed's own projection for the commit, never a journal read of its own.
  it('reads Stopping once per commit while a send waits on it', async () => {
    rig = await createQueuedMessageTestRig()
    await turn('turn-1', await rig.workingSend(), 'running')
    await journal().appendStopEvent({ reason: 'user-stop' }, 1)
    const settle = journal().stopMarks.beginSettle()
    expect(await rig.send('sent while the Stop settles').result).toMatchObject({ ok: true })
    await laneDrained()
    const reads = vi.spyOn(journal(), 'snapshot')

    for (let row = 0; row < 3; row += 1) {
      await journal().appendItem(
        { provider: 'orca', clientMessageId: `streamed-${row}` },
        { kind: 'status', text: `still streaming ${row}` },
        {
          fence: rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
      await laneDrained()
    }

    expect(reads.mock.calls.length).toBeLessThanOrEqual(3)
    journal().stopMarks.settled(settle)
  })
})
