import { expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionQueueRequest } from '../../../renderer/src/components/native-chat/structured-agent-session-queue-request'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

async function queueCompact(rig: Awaited<ReturnType<typeof createQueuedMessageTestRig>>) {
  const id = hostTestOperationId()
  const fields = { command: 'compact' as const, delivery: 'queue-if-active' as const }
  expect(
    await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', id),
      ...fields,
      userSend: true
    })
  ).toMatchObject({ ok: true, value: { queued: { messageId: id } } })
  return id
}

it.each([
  { followUpsQueue: false, alternate: undefined },
  { followUpsQueue: true, alternate: true }
])(
  'fresh and stale publication both run C,D,M before later cards (Queue=$followUpsQueue)',
  async ({ followUpsQueue, alternate }) => {
    vi.useFakeTimers()
    try {
      for (const fresh of [true, false]) {
        const rig = await createQueuedMessageTestRig()
        try {
          const working = await rig.workingSend()
          const compactId = await queueCompact(rig)
          const earlier = rig.send('earlier card', 'queue-if-active')
          await earlier.result
          const delivery = structuredAgentSessionQueueRequest(
            {
              capability: 'supported',
              followUpsQueue,
              isWorking: true,
              stopping: false,
              session: {
                queuedMessages: fresh
                  ? [
                      {
                        messageId: compactId,
                        state: 'waiting',
                        body: {
                          kind: 'message',
                          role: 'user',
                          blocks: [],
                          command: { name: 'compact' }
                        },
                        position: 1
                      }
                    ]
                  : []
              },
              prompts: []
            },
            alternate
          )
          const later = rig.send('after compaction and the earlier card', delivery)
          expect(await later.result).toMatchObject({
            ok: true,
            value: fresh ? { queued: {} } : { submission: { clientMessageId: later.id } }
          })
          const tail = rig.send('newer card', 'queue-if-active')
          await tail.result
          await vi.advanceTimersByTimeAsync(100)
          expect(rig.dispatch).toHaveBeenCalledOnce()
          expect(rig.compact).not.toHaveBeenCalled()
          await rig.settleAccepted(working, 'first')
          await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
          expect(rig.dispatch).toHaveBeenCalledOnce()
          const command = rig.compact.mock.calls[0]![0].command
          const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
          rig.finishCompact()
          await eventually(() =>
            expect(journal.item(agentJournalItemKey(command.identity))?.body).toMatchObject({
              kind: 'turn',
              state: 'completed'
            })
          )
          await eventually(async () =>
            expect((await rig.handoff(earlier.id))?.handedOverAt).toBeDefined()
          )
          const earlierId = await rig.handoffId(earlier.id)
          expect(rig.dispatch.mock.calls.at(-1)?.[0].clientMessageId).toBe(earlierId)
          await rig.settleAccepted(earlierId, 'earlier')
          await eventually(async () =>
            expect(
              fresh
                ? (await rig.handoff(later.id))?.handedOverAt
                : (await rig.submission(later.id))?.handedOverAt
            ).toBeDefined()
          )
          const laterId = fresh ? await rig.handoffId(later.id) : later.id
          expect(rig.dispatch.mock.calls.at(-1)?.[0].clientMessageId).toBe(laterId)
          expect(await rig.handoff(tail.id)).toBeUndefined()
          await rig.settleAccepted(laterId, 'later')
          expect(await rig.submission(laterId)).toMatchObject({ dispatchState: 'accepted' })
          await eventually(async () =>
            expect((await rig.handoff(tail.id))?.handedOverAt).toBeDefined()
          )
          expect(rig.dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([
            working,
            earlierId,
            laterId,
            await rig.handoffId(tail.id)
          ])
        } finally {
          await rig.dispose()
        }
      }
    } finally {
      vi.useRealTimers()
    }
  }
)

it('explicit card Send after handover entry preserves the committed input then card, once each', async () => {
  vi.useFakeTimers()
  const rig = await createQueuedMessageTestRig()
  try {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    const card = rig.send('explicit card', 'queue-if-active')
    await card.result
    const prepared = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: string[] = []
    let held = false
    rig.dispatch.mockImplementation(async (input) => {
      if (
        !held &&
        input.body.blocks.some((block) => block.type === 'text' && block.text === 'preparing input')
      ) {
        held = true
        prepared.resolve()
        await release.promise
      }
      writes.push(input.clientMessageId)
      return { state: 'admitted' }
    })
    const message = rig.send('preparing input')
    await message.result
    await prepared.promise
    expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    const sent = await rig.sendNow(card.id)
    expect(sent).toMatchObject({ ok: true, value: { submission: { queuedMessageId: card.id } } })
    release.resolve()
    await eventually(async () => expect((await rig.handoff(card.id))?.handedOverAt).toBeDefined())
    const cardId = await rig.handoffId(card.id)
    await eventually(() => expect(writes).toEqual([message.id, cardId]))
    expect(rig.dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([
      working,
      message.id,
      cardId
    ])
    await rig.settleAccepted(cardId, 'card')
    await rig.settleAccepted(message.id, 'message')
    await rig.settleAccepted(working, 'working')
    expect(await rig.submission(message.id)).toMatchObject({ dispatchState: 'accepted' })
  } finally {
    await rig.dispose()
    vi.useRealTimers()
  }
})

it('removing C and explicitly sending D keeps forced M queued until W actually ends', async () => {
  vi.useFakeTimers()
  const rig = await createQueuedMessageTestRig()
  try {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    const compactId = await queueCompact(rig)
    const earlier = rig.send('D', 'queue-if-active')
    await earlier.result
    const message = rig.send('forced M without delivery')
    await message.result
    await rig.deleteQueued(compactId)
    await rig.sendNow(earlier.id)
    await eventually(async () =>
      expect((await rig.handoff(earlier.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(await rig.handoffId(earlier.id), 'explicit-D')
    await vi.advanceTimersByTimeAsync(100)
    expect((await rig.submission(message.id))?.handedOverAt).toBeUndefined()
    expect(await rig.submission(message.id)).toMatchObject({ dispatchState: 'pending' })
    expect(rig.compact).not.toHaveBeenCalled()
    await rig.settleAccepted(working, 'W')
    await openRigTurnFor(rig, working, 'interrupted')
    await eventually(async () =>
      expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(message.id, 'M')
    expect(await rig.submission(message.id)).toMatchObject({ dispatchState: 'accepted' })
  } finally {
    await rig.dispose()
    vi.useRealTimers()
  }
})

it('reselects after the external reservation wait without rejecting the original pending input', async () => {
  const rig = await createQueuedMessageTestRig()
  let release = () => {}
  try {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    const card = rig.send('explicit before entry', 'queue-if-active')
    await card.result
    const { conversationDelivery, serialize } = rig.host.collaboratorsForTests()
    const order = conversationDelivery.loop['deps'].deliveryOrder
    const held = order.reserve(SESSION)
    release = held.release
    const entered = Promise.withResolvers<void>()
    const before = order.beforeSend.bind(order)
    const waiting = vi.spyOn(order, 'beforeSend').mockImplementation((...args) => {
      entered.resolve()
      return before(...args)
    })
    const message = rig.send('original M still pending')
    await message.result
    await entered.promise
    expect(await rig.submission(message.id)).toMatchObject({ dispatchState: 'pending' })
    expect((await rig.submission(message.id))?.handedOverAt).toBeUndefined()
    await rig.sendNow(card.id)
    await serialize(SESSION, async () => {})
    release()
    await eventually(async () => expect((await rig.handoff(card.id))?.handedOverAt).toBeDefined())
    const cardId = await rig.handoffId(card.id)
    await eventually(async () =>
      expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    )
    expect(rig.dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([
      working,
      cardId,
      message.id
    ])
    await rig.settleAccepted(cardId, 'card')
    await rig.settleAccepted(message.id, 'M')
    expect(await rig.submission(message.id)).toMatchObject({ dispatchState: 'accepted' })
    waiting.mockRestore()
  } finally {
    release()
    await rig.dispose()
  }
})

it('streams N and 10N frames without rescanning queue/history or waking a forced input', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    const compactId = await queueCompact(rig)
    const message = rig.send('forced M')
    await message.result
    const { sessions, conversationDelivery, serialize } = rig.host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    const scope = { kind: 'thread' as const }
    for (let index = 0; index < 100; index++) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `old-${index}` },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'history' }] },
        { fence: 1, turnScope: scope }
      )
    }
    await serialize(SESSION, async () => {})
    const pauses = vi.spyOn(journal.queuedMessages, 'pauses')
    const visits = vi.spyOn(journal, 'visitItems')
    const wake = vi.spyOn(conversationDelivery.loop, 'wake')
    let revision = 0
    for (const count of [10, 100]) {
      pauses.mockClear()
      visits.mockClear()
      wake.mockClear()
      for (let index = 0; index < count; index++) {
        rig.providerEvents().appendItem(
          { provider: 'orca', clientMessageId: 'stream' },
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: `token-${revision++}` }]
          },
          { turnScope: scope }
        )
        await rig.host.flushStreamedEvents(SESSION)
        await serialize(SESSION, async () => {})
      }
      expect(pauses).not.toHaveBeenCalled()
      expect(visits).not.toHaveBeenCalled()
      expect(wake).not.toHaveBeenCalled()
      expect(journal.submission(message.id)?.handedOverAt).toBeUndefined()
    }
    pauses.mockRestore()
    visits.mockRestore()
    wake.mockRestore()
    await rig.settleAccepted(working, 'W')
    await openRigTurnFor(rig, working, 'interrupted')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    rig.finishCompact()
    await eventually(async () =>
      expect((await rig.submission(message.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(message.id, 'M')
    expect(await rig.handoff(compactId)).toMatchObject({ dispatchState: 'accepted' })
    expect(await rig.submission(message.id)).toMatchObject({ dispatchState: 'accepted' })
  } finally {
    await rig.dispose()
  }
})

it.each(['resume', 'new-send'] as const)(
  'restart holds C,D,M in their place until %s releases the queue',
  async (release) => {
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    try {
      await rig.workingSend()
      const compactId = await queueCompact(rig)
      const earlier = rig.send('D before held M', 'queue-if-active')
      await earlier.result
      const message = rig.send('M kept after restart')
      await message.result
      const tail = rig.send('later card', 'queue-if-active')
      await tail.result
      await rig.restartHostProcess()
      expect(await rig.submission(message.id)).toMatchObject({
        dispatchState: 'rejected',
        keptAsQueuedMessageId: message.id
      })
      expect((await rig.drafts()).map((card) => card.messageId)).toEqual([
        compactId,
        earlier.id,
        message.id,
        tail.id
      ])
      expect(rig.compact).not.toHaveBeenCalled()
      expect(await rig.handoff(message.id)).toBeUndefined()
      if (release === 'resume') {
        expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
      } else {
        const next = rig.send('N releases reopen only when accepted')
        expect(await next.result).toMatchObject({ ok: true })
        await eventually(async () =>
          expect((await rig.submission(next.id))?.handedOverAt).toBeDefined()
        )
        expect(rig.compact).not.toHaveBeenCalled()
        await rig.settleAccepted(next.id, 'N')
      }
      await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
      const command = rig.compact.mock.calls[0]![0].command
      rig.finishCompact()
      const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      await eventually(() =>
        expect(journal.item(agentJournalItemKey(command.identity))?.body).toMatchObject({
          kind: 'turn',
          state: 'completed'
        })
      )
      for (const id of [earlier.id, message.id, tail.id]) {
        await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
        const handed = await rig.handoffId(id)
        await rig.settleAccepted(handed, id)
        expect(await rig.submission(handed)).toMatchObject({ dispatchState: 'accepted' })
      }
      expect(
        rig.dispatch.mock.calls.filter(([input]) => input.clientMessageId === message.id)
      ).toHaveLength(0)
    } finally {
      await rig.dispose()
    }
  }
)
