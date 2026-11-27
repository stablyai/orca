import { expect, it, vi } from 'vitest'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  claudeReceiptIngress,
  faultingReceiptPublisher,
  openReceiptStream
} from './structured-agent-session-provider-receipt-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  hostTestMessage,
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data.test-fixture'
import { structuredAgentSessionHandingOver } from '../../delivery/structured-agent-session-handing-over'
import { retireWaiter } from '../../../../claude/structured/dispatch/claude-structured-dispatch-waiters'

it.each(['discard', 'stall', 'throw', 'reject'] as const)(
  'preserves Claude lifecycle, durable echo and assistant content after receipt %s',
  async (failure) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
    try {
      const id = await rig.workingSend()
      await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
      const journal = (await rig.host.conversation(CHAT)).journal
      const child = rig.host.collaboratorsForTests().sessions.get(CHAT)?.child
      await eventually(() => expect(structuredAgentSessionHandingOver(journal).size).toBe(0))
      const ingress = claudeReceiptIngress(rig)
      const stream = await openReceiptStream(rig, { paused: true })
      const fails = failure === 'throw' || failure === 'reject'
      const publisher = fails ? faultingReceiptPublisher(failure) : undefined
      if (publisher) {
        vi.spyOn(ingress.sink, 'recordProviderReceipt').mockImplementation(publisher.publish)
      }
      // The ingress binds the translator for each incoming frame.
      const translator = vi.spyOn(ingress.translator, 'handle')
      const read = fails ? undefined : stream.read()
      const cursor = journal.cursor()
      const activity = rig.host.collaboratorsForTests().sessions.lastActivityAt(CHAT)
      ingress.lifecycle('queued', NOW + 100)
      ingress.lifecycle('queued', NOW + 110)
      ingress.lifecycle('started', NOW + 150)
      expect(await ingress.flush()).toEqual({ ok: true })
      expect(ingress.waiter.commandLifecycle).toBe('started')
      expect(translator).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.objectContaining({ state: 'queued' }) })
      )
      if (fails) {
        expect(publisher?.publish).toHaveBeenCalledTimes(1)
        if (failure === 'reject') {
          expect(publisher?.handled).toHaveBeenCalledOnce()
        }
        expect(stream.frames).toHaveLength(1)
      } else {
        await read
        expect(stream.frames[1]?.updates).toEqual([{ clientMessageId: id, observedAt: NOW + 100 }])
      }
      expect(journal.cursor()).toEqual(cursor)
      expect(rig.host.collaboratorsForTests().sessions.lastActivityAt(CHAT)).toEqual(activity)
      expect(await journal.reads.runningTurn()).toBeNull()

      ingress.echo()
      ingress.assistant()
      expect(await ingress.flush()).toEqual({ ok: true })
      expect((await rig.submission(id))?.dispatchState).toBe('accepted')
      expect(await journal.reads.runningTurn()).toMatchObject({
        item: { body: { startedAt: NOW + 200 } }
      })
      await eventually(() => expect(JSON.stringify(stream.structural)).toContain('Hello there'))
      expect(rig.host.collaboratorsForTests().sessions.get(CHAT)?.child).toBe(child)
      expect(rig.closeSession).not.toHaveBeenCalled()

      if (!fails) {
        expect(stream.frames).toHaveLength(2)
        await stream.read({ discarded: failure === 'discard' })
        const last = stream.frames.at(-1)
        expect(last?.revision.sequence).toBeGreaterThan(stream.frames[1]!.revision.sequence)
        expect(last?.updates.some((update) => update.observedAt !== null)).toBe(false)
      }
      stream.close()
    } finally {
      await rig.dispose()
    }
  }
)

it('withdraws a retired waiter before any durable settlement and ignores its old callback', async () => {
  const rig = await createQueuedMessageTestRig({ agent: 'claude' })
  try {
    const id = await rig.workingSend()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
    const ingress = claudeReceiptIngress(rig)
    const stream = await openReceiptStream(rig)
    ingress.lifecycle('started', NOW + 100)
    await eventually(() => expect(stream.frames).toHaveLength(2))
    retireWaiter(ingress.session, ingress.waiter)
    ingress.lifecycle('queued', NOW + 200)
    await eventually(() => expect(stream.frames).toHaveLength(3))
    expect(stream.frames[2]?.updates).toEqual([{ clientMessageId: id, observedAt: null }])
    expect((await rig.submission(id))?.dispatchState).toBe('pending')
    ingress.sink.recordProviderReceipt?.({
      clientMessageId: id,
      fence: ingress.fence,
      ...ingress.handover,
      observedAt: NOW + 400
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stream.frames).toHaveLength(3)
    stream.close()
  } finally {
    await rig.dispose()
  }
})

it.each(['late echo', 'mail read'] as const)(
  'preserves the other pending send receipt across a %s that seals the sink',
  async (operation) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
    try {
      const first = await rig.workingSend()
      await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
      const firstIngress = claudeReceiptIngress(rig)
      const { journal, child, providerReceipts } = await rig.host.conversation(CHAT)
      const second = 'another-pending-send'
      const body = hostTestMessage('a second send')
      const { fence } = firstIngress
      await journal.appendSubmission({
        clientMessageId: second,
        fence,
        handoverRecorded: true,
        payloadFingerprint: second,
        body,
        origin: 'client'
      })
      const { handover } = await journal.prepareHandover({
        clientMessageId: second,
        fence,
        turnScope: { kind: 'thread' },
        body
      })
      providerReceipts!.register(CHAT, journal, child!, second, handover)
      const secondIngress = claudeReceiptIngress(rig, {
        clientMessageId: second,
        fence,
        handover: () => handover
      })
      const stream = await openReceiptStream(rig)
      firstIngress.lifecycle('queued', NOW + 100)
      secondIngress.lifecycle('queued', NOW + 110)
      await eventually(() => {
        expect(stream.frames.flatMap((frame) => frame.updates)).toEqual([
          { clientMessageId: first, observedAt: NOW + 100 },
          { clientMessageId: second, observedAt: NOW + 110 }
        ])
      })

      if (operation === 'late echo') {
        firstIngress.echo()
        expect(await firstIngress.flush()).toEqual({ ok: true })
        expect((await rig.submission(first))?.dispatchState).toBe('accepted')
      } else {
        const hold = await rig.host.holdMailSources(
          [{ mailbox_handle: 'mailbox', message_id: first, operation_id: first, session_id: CHAT }],
          new AbortController().signal
        )
        try {
          expect(hold.current()).toBe(true)
        } finally {
          hold.release()
        }
      }

      expect((await rig.submission(second))?.dispatchState).toBe('pending')
      const restated = await openReceiptStream(rig)
      expect(restated.frames[0]?.updates).toEqual([
        ...(operation === 'mail read' ? [{ clientMessageId: first, observedAt: NOW + 100 }] : []),
        { clientMessageId: second, observedAt: NOW + 110 }
      ])
      stream.close()
      restated.close()
    } finally {
      await rig.dispose()
    }
  }
)

it.each([false, true])(
  'preserves the owed opening frame at the last structural cursor (bounded frames %s)',
  async (boundedFrames) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
    const captured = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const id = await rig.workingSend()
      await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
      const ingress = claudeReceiptIngress(rig)
      const journal = (await rig.host.conversation(CHAT)).journal
      await eventually(() => expect(structuredAgentSessionHandingOver(journal).size).toBe(0))
      const cursor = journal.cursor()
      const history = JSON.stringify(await rig.host.history({ sessionId: CHAT, direction: 'tail' }))
      const control: string[] = []
      const raced: string[] = []
      const stopControl = await rig.host.subscribe({
        id: 'control',
        sessionId: CHAT,
        boundedFrames,
        cursor,
        emit: (event) => void control.push(JSON.stringify(event))
      })
      await eventually(() => expect(control.some((frame) => frame.includes(id))).toBe(true))
      const stopRaced = await rig.host.subscribe({
        id: 'raced',
        sessionId: CHAT,
        boundedFrames,
        cursor,
        emit: (event) => void raced.push(JSON.stringify(event)),
        projectJournalEvent: async (_journal, event) => {
          captured.resolve()
          await resume.promise
          return event
        }
      })
      const receipt = await openReceiptStream(rig)
      try {
        await captured.promise
        ingress.lifecycle('queued', NOW + 100)
        await eventually(() => expect(JSON.stringify(receipt.frames)).toContain(id))
        expect(raced).toEqual([])
        expect(journal.cursor()).toEqual(cursor)
        resume.resolve()
        await eventually(() => expect(raced).toEqual(control))
        expect(raced.filter((frame) => frame.includes(id))).toHaveLength(1)
        expect(JSON.stringify(await rig.host.history({ sessionId: CHAT, direction: 'tail' }))).toBe(
          history
        )
      } finally {
        stopControl()
        stopRaced()
        receipt.close()
      }
    } finally {
      resume.resolve()
      clock.mockRestore()
      await rig.dispose()
    }
  }
)

it('restates a fresh set after settlement, re-handover and replacement of a stalled stream', async () => {
  const rig = await createQueuedMessageTestRig({ agent: 'claude' })
  try {
    const id = await rig.workingSend()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
    const ingress = claudeReceiptIngress(rig)
    const first = await openReceiptStream(rig, { paused: true })
    ingress.lifecycle('queued', NOW + 100)
    const { sessions } = rig.host.collaboratorsForTests()
    const session = sessions.get(CHAT)!
    const { journal, child, providerReceipts } = session
    const next = await journal.prepareHandover({
      clientMessageId: id,
      fence: ingress.fence,
      turnScope: { kind: 'thread' },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'work on this' }] }
    })
    providerReceipts!.register(CHAT, journal, child!, id, next.handover)
    const stamp = (handover: typeof ingress.handover, observedAt: number) =>
      ingress.sink.recordProviderReceipt?.({
        ...handover,
        observedAt,
        fence: ingress.fence,
        clientMessageId: id
      })
    stamp(ingress.handover, NOW + 200)
    stamp({ ...next.handover!, attempt: next.handover!.attempt + 1 }, NOW + 210)
    stamp(next.handover!, NOW + 220)
    const replacement = await openReceiptStream(rig)
    expect(replacement.frames[0]).toMatchObject({
      hostIncarnation: first.frames[0]!.hostIncarnation,
      updates: [{ clientMessageId: id, observedAt: NOW + 220 }]
    })
    expect(replacement.frames[0]!.subscription).not.toBe(first.frames[0]!.subscription)
    first.close()
    await rig.settleAccepted(id, 'accepted')
    await eventually(() => {
      const last = replacement.frames.at(-1)
      expect(last?.revision.sequence).toBeGreaterThan(replacement.frames[0]!.revision.sequence)
      expect(last?.updates).toEqual(
        last?.replace ? [] : [{ clientMessageId: id, observedAt: null }]
      )
    })
    replacement.close()
    const empty = await openReceiptStream(rig)
    expect(empty.frames[0]).toMatchObject({ replace: true, updates: [] })
    expect(first.frames).toHaveLength(1)
    empty.close()
  } finally {
    await rig.dispose()
  }
})

it('loses published confirmations on restart while an accepted send and an unhanded card recover', async () => {
  const rig = await createQueuedMessageTestRig({
    agent: 'claude',
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
  try {
    const accepted = await rig.workingSend()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
    await rig.settleAccepted(accepted, 'durable-echo')
    const pending = await rig.workingSend()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
    const ingress = claudeReceiptIngress(rig)
    const stream = await openReceiptStream(rig)
    ingress.lifecycle('queued', NOW + 100)
    await eventually(() =>
      expect(stream.frames[1]?.updates).toEqual([
        { clientMessageId: pending, observedAt: NOW + 100 }
      ])
    )
    const previous = rig.host
    previous.stopDelivery()
    const journal = (await previous.conversation(CHAT)).journal
    const card = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'hold me' }]
    }
    await journal.appendSubmission({
      clientMessageId: 'hold-me',
      fence: ingress.fence,
      handoverRecorded: true,
      payloadFingerprint: 'hold-me',
      body: card,
      origin: 'client'
    })
    await journal.close()
    await rig.crashRestartHostFromDisk()
    await rig.host.reconcileRestartLeases()
    const after = await openReceiptStream(rig)
    expect(after.frames[0]?.hostIncarnation).not.toBe(stream.frames[0]?.hostIncarnation)
    expect(after.frames[0]?.updates).toEqual([])
    expect(await rig.submission(accepted)).toMatchObject({ dispatchState: 'accepted' })
    expect(await rig.submission(pending)).toMatchObject({
      dispatchState: 'unknown',
      reason: 'host_restarted_before_acknowledgement'
    })
    expect(await rig.drafts()).toContainEqual(expect.objectContaining({ state: 'waiting' }))
    expect(rig.dispatch).toHaveBeenCalledTimes(2)
    after.close()
    stream.close()
  } finally {
    await rig.dispose()
  }
})

it('stamps Claude compact through the command handover without changing its running row', async () => {
  const rig = await createQueuedMessageTestRig({ agent: 'claude' })
  try {
    const prior = await rig.workingSend()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
    await rig.settleAccepted(prior, 'prior')
    const stream = await openReceiptStream(rig)
    const observed = Promise.withResolvers<void>()
    const journal = (await rig.host.conversation(CHAT)).journal
    rig.compact.mockImplementationOnce(async ({ command, fence }) => {
      const ingress = claudeReceiptIngress(rig, {
        handover: () => command.handover,
        clientMessageId: command.clientMessageId,
        fence
      })
      const before = await journal.reads.runningTurn()
      expect(before).toMatchObject({ turnId: command.turnId, item: { body: command.running } })
      const cursor = journal.cursor()
      const bytes = JSON.stringify(await rig.host.history({ sessionId: CHAT, direction: 'tail' }))
      const frames = stream.structural.length
      ingress.lifecycle('started', NOW + 400)
      ingress.lifecycle('queued', NOW + 500)
      await expect(ingress.flush()).resolves.toEqual({ ok: true })
      await eventually(() =>
        expect(stream.frames[1]?.updates).toEqual([
          { clientMessageId: command.clientMessageId, observedAt: NOW + 400 }
        ])
      )
      expect(journal.cursor()).toEqual(cursor)
      expect(await journal.reads.runningTurn()).toEqual(before)
      expect(JSON.stringify(await rig.host.history({ sessionId: CHAT, direction: 'tail' }))).toBe(
        bytes
      )
      expect(stream.structural).toHaveLength(frames)
      observed.resolve()
      return { state: 'admitted' }
    })
    const command = 'compact'
    const id = '1800000000000-00000000000000000000000000000099'
    await rig.host.conversationCommand(
      { callerKey: 'client-1' },
      { envelope: rig.envelope({ command }, 'agentSession.conversationCommand', id), command }
    )
    await observed.promise
    stream.close()
  } finally {
    await rig.dispose()
  }
})
