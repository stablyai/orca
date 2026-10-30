import { expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { loadTestJournal } from '../agent-session-journal/journal-host-database-test-support'
import { queuePauseHolding } from '../agent-session-journal/queued-message-pause'

it.each([false, true])(
  'failed reopen=%s: unentered M retains ordinary head recovery through graceful restart',
  async (fail) => {
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    let release = () => {}
    try {
      const warm = await rig.workingSend()
      await rig.settleAccepted(warm, 'warm')
      const { sessions, serialize, conversationDelivery } = rig.host.collaboratorsForTests()
      const journal = sessions.get(SESSION)!.journal
      await serialize(SESSION, async () => {
        await journal.queuedMessages.insert({
          messageId: 'C',
          body: { ...hostTestMessage('/compact'), command: { name: 'compact' } }
        })
        const mark = fail
          ? vi
              .spyOn(journal, 'appendQueueReopen')
              .mockRejectedValueOnce(new Error('injected reopen write failure'))
          : null
        await journal.markQueueReopen(1).catch(() => {})
        mark?.mockRestore()
      })
      const n = rig.send('N opens work without an accepted echo')
      expect(await n.result).toMatchObject({ ok: true })
      await eventually(async () => expect((await rig.submission(n.id))?.handedOverAt).toBeDefined())
      await openRigTurnFor(rig, n.id)
      expect(journal.queuedMessages.pauses().map((p) => p.reason)).toEqual(['restarted'])

      const order = conversationDelivery.loop['deps'].deliveryOrder
      const reserved = order.reserve(SESSION)
      release = reserved.release
      const before = order.beforeSend.bind(order)
      const waiting = vi.spyOn(order, 'beforeSend').mockImplementation((...args) => before(...args))
      const effectiveEligible = journal.queuedMessages
        .list()
        .filter(
          (card) =>
            card.state === 'waiting' &&
            card.holdReason === null &&
            !queuePauseHolding(journal.queuedMessages.pauses(), card)
        )
        .map((card) => card.messageId)
      expect(effectiveEligible).toEqual([])
      const m = rig.send('M ordinary steer while C is held, never entered', undefined, {
        carried: { personality: 'friendly', effort: 'high' }
      })
      expect(await m.result).toMatchObject({ ok: true })
      await serialize(SESSION, async () => {})
      await eventually(() => expect(waiting.mock.calls.some(([, id]) => id === m.id)).toBe(true))
      expect(await rig.submission(m.id)).toMatchObject({ dispatchState: 'pending' })
      expect((await rig.submission(m.id))?.handedOverAt).toBeUndefined()
      expect(rig.dispatch.mock.calls.some(([input]) => input.clientMessageId === m.id)).toBe(false)
      const original = journal.submission(m.id)!
      const receipt = rig.store.readCommandReceipt({ kind: 'global' }, m.id)
      expect(receipt).toMatchObject({
        verdict: 'readable',
        receipt: {
          status: 'accepted',
          method: 'agentSession.send',
          result: { kind: 'journal-row', epoch: journal.epoch, sequence: original.acceptedSequence }
        }
      })
      expect(original.options).toEqual({ personality: 'friendly', effort: 'high' })
      const replayBefore = loadTestJournal(rig.root, SESSION)!
      expect(replayBefore.damage).toBeNull()
      expect(replayBefore.newer).toBeNull()
      expect(journal.inputOrder.prefix(m.id)).toEqual([])
      expect(replayBefore.state.inputOrder.prefix(m.id)).toEqual([])
      waiting.mockRestore()

      await rig.restartHostProcess()
      const replayAfter = loadTestJournal(rig.root, SESSION)!
      expect(replayAfter.damage).toBeNull()
      expect(replayAfter.newer).toBeNull()
      const shutdownM = replayAfter.state.submissions.get(m.id)
      expect(shutdownM?.handedOverAt).toBeUndefined()
      const recoveredM = await rig.submission(m.id)
      expect(recoveredM).toMatchObject({ dispatchState: 'rejected', keptAsQueuedMessageId: m.id })
      expect(recoveredM?.handedOverAt).toBeUndefined()
      expect(recoveredM?.options).toEqual(original.options)
      expect(recoveredM?.payloadFingerprint).toBe(original.payloadFingerprint)
      expect(recoveredM?.acceptedSequence).toBe(original.acceptedSequence)
      const reopened = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      expect(rig.store.readCommandReceipt({ kind: 'global' }, m.id)).toEqual(receipt)
      expect(reopened.queuedMessages.get(m.id)).toMatchObject({
        body: hostTestMessage('M ordinary steer while C is held, never entered'),
        options: original.options
      })
      const cards = reopened.queuedMessages.list().filter((c) => c.state === 'waiting')
      const observedOrder = cards.map((c) => c.messageId)
      expect(observedOrder).toEqual([m.id, 'C'])
      expect(rig.compact).not.toHaveBeenCalled()
      const deliveries: string[] = []
      expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
      for (const id of observedOrder) {
        if (id === 'C') {
          await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
          deliveries.push('C')
          const command = rig.compact.mock.calls[0]![0].command
          rig.finishCompact()
          await eventually(() =>
            expect(reopened.item(agentJournalItemKey(command.identity))?.body).toMatchObject({
              kind: 'turn',
              state: 'completed'
            })
          )
        } else {
          await eventually(async () =>
            expect((await rig.handoff(m.id))?.handedOverAt).toBeDefined()
          )
          deliveries.push('M')
          const handoff = await rig.handoffId(m.id)
          expect(rig.compact).not.toHaveBeenCalled()
          await rig.settleAccepted(handoff, 'M-after-restart')
          expect(await rig.submission(handoff)).toMatchObject({ dispatchState: 'accepted' })
        }
      }
      expect(deliveries).toEqual(['M', 'C'])
    } finally {
      release()
      await rig.dispose()
    }
  }
)

it.each([false, true])(
  'reopen mark failure=%s keeps a paused command from forcing a later steer',
  async (fail) => {
    const rig = await createQueuedMessageTestRig()
    try {
      const warm = await rig.workingSend()
      await rig.settleAccepted(warm, 'warm')
      const { sessions, serialize } = rig.host.collaboratorsForTests()
      const journal = sessions.get(SESSION)!.journal
      await serialize(SESSION, async () => {
        await journal.queuedMessages.insert({
          messageId: 'C',
          body: { ...hostTestMessage('/compact'), command: { name: 'compact' } }
        })
        const mark = fail
          ? vi.spyOn(journal, 'appendQueueReopen').mockRejectedValueOnce(new Error('disk full'))
          : null
        await journal.markQueueReopen(1).catch(() => {})
        mark?.mockRestore()
      })
      expect(journal.queuedMessages.pauses().map((p) => p.reason)).toEqual(['restarted'])
      const n = rig.send('N opens next work')
      expect(await n.result).toMatchObject({ ok: true })
      await eventually(async () => expect((await rig.submission(n.id))?.handedOverAt).toBeDefined())
      await openRigTurnFor(rig, n.id)
      expect(journal.queuedMessages.pauses().map((p) => p.reason)).toEqual(['restarted'])
      const m = rig.send('M steer while C is held')
      expect(await m.result).toMatchObject({
        ok: true,
        value: { submission: { clientMessageId: m.id } }
      })
      await serialize(SESSION, async () => {})
      expect(journal.inputOrder.prefix(m.id)).toEqual([])
      expect(rig.compact).not.toHaveBeenCalled()
      await eventually(async () => expect((await rig.submission(m.id))?.handedOverAt).toBeDefined())
      await rig.settleAccepted(n.id, 'N')
      expect(journal.queuedMessages.pauses()).toEqual([])
      const later = rig.send('later admission after actual accepted N')
      expect(await later.result).toMatchObject({ ok: true })
      expect(journal.inputOrder.prefix(later.id).map((c) => c.messageId)).toEqual(['C'])
      await rig.settleAccepted(m.id, 'M')
      await openRigTurnFor(rig, n.id, 'interrupted')
      await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
      const command = rig.compact.mock.calls[0]![0].command
      expect(journal.submission(later.id)?.handedOverAt).toBeUndefined()
      rig.finishCompact()
      await eventually(() =>
        expect(journal.item(agentJournalItemKey(command.identity))?.body).toMatchObject({
          kind: 'turn',
          state: 'completed'
        })
      )
      await eventually(async () =>
        expect((await rig.submission(later.id))?.handedOverAt).toBeDefined()
      )
      await rig.settleAccepted(later.id, 'later')
      for (const id of [n.id, m.id, later.id]) {
        expect(journal.submission(id)?.dispatchState).toBe('accepted')
        expect(
          rig.dispatch.mock.calls.filter(([input]) => input.clientMessageId === id)
        ).toHaveLength(1)
      }
    } finally {
      await rig.dispose()
    }
  }
)
