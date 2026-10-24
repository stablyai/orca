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

async function laneDrained(): Promise<void> {
  for (let step = 0; step < 5; step += 1) {
    await rig.host['tasks'].serialize(HOST_TEST_SESSION, async () => {})
  }
}

async function stoppingTurn(options: { card?: true; refused?: true } = {}) {
  rig = await createQueuedMessageTestRig()
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
  expect(await rig.stop()).toMatchObject({ ok: true })
  await eventually(() => expect(status()).toMatchObject({ stopping: true }))
  return { sent, status, cardId, dispatched: rig.dispatch.mock.calls.length }
}

describe("a message sent while a person's Stop ends the turn", () => {
  it.each([
    ['a queued card sent now', true, false],
    ['a send', false, false],
    ['a send, after a Stop the agent declined', false, true]
  ])('waits for the turn to end, then runs as its own turn: %s', async (_, fromCard, refused) => {
    const { sent, status, cardId, dispatched } = await stoppingTurn({
      ...(fromCard ? { card: true as const } : {}),
      ...(refused ? { refused: true as const } : {})
    })

    const result = cardId ? await rig.sendNow(cardId) : await rig.send('one more thing').result
    expect(result).toMatchObject({ ok: true })
    await laneDrained()
    const held = await rig.submission(result.ok ? result.value.clientMessageId : '')
    expect(held).toMatchObject({ dispatchState: 'pending' })
    expect(held?.handedOverAt).toBeUndefined()
    expect(rig.dispatch.mock.calls.length).toBe(dispatched)
    expect(status()).toMatchObject({ stopping: true })

    await turn('turn-1', sent, 'interrupted')

    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1))
  })

  // A no-op Stop ends no future turn; later sends may join the opening turn once it appears.
  it('hands over a send made after a Stop that stopped nothing once the turn opens, with no Stopping flip', async () => {
    rig = await createQueuedMessageTestRig()
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

    const later = rig.send('sent before the turn opened')
    answer.resolve({ cancelled: false })
    expect(await stopped).toMatchObject({ ok: true })
    expect(await later.result).toMatchObject({ ok: true })
    const { loop } = rig.host.collaboratorsForTests().conversationDelivery
    await eventually(() => expect(loop.isRunning(HOST_TEST_SESSION)).toBe(false))
    expect((await rig.submission(later.id))?.handedOverAt).toBeUndefined()

    await rig.settleAccepted(first, 'first')
    await turn('turn-1', first, 'running')
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1))
    await laneDrained()
    expect(seen.at(-1)).toBeUndefined()
    expect(seen.slice(seen.lastIndexOf(true) + 1)).not.toContain(true)
  })

  // Settlement without rows must still wake held delivery.
  it('hands a held send over when the Stop settles with no row after it', async () => {
    rig = await createQueuedMessageTestRig()
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

  it('holds a send that a Stop overtook between its delivery step and the handover', async () => {
    rig = await createQueuedMessageTestRig()
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

    const stopped = rig.stop()
    const second = rig.send('and this one')
    step.release()
    expect(await stopped).toMatchObject({ ok: true })
    expect(await second.result).toMatchObject({ ok: true })
    await eventually(() => expect(status()).toMatchObject({ stopping: true }))
    await laneDrained()

    expect(rig.dispatch.mock.calls.length).toBe(dispatched)
    expect((await rig.submission(second.id))?.handedOverAt).toBeUndefined()
    await turn('turn-1', sent, 'interrupted')
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1))
  })

  it('reads Stopping once per commit while a send waits on it', async () => {
    const { cardId } = await stoppingTurn({ card: true })
    expect(await rig.sendNow(cardId ?? '')).toMatchObject({ ok: true })
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
  })
})
