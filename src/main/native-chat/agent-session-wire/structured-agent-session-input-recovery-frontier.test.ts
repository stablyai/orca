import { journalInputOrder } from '../agent-session-journal/journal-input-order'
import { writeLegacyGapFixture } from './structured-agent-session-legacy-gap.test-support'
import type { JournalReducerState } from '../agent-session-journal/journal-reducer'
import { expect, it, vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  loadTestJournal,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { selectStructuredAgentSessionInput } from './structured-agent-session-input-selection'
import {
  createQueuedMessageTestRig,
  eventually
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

it.each([
  { mode: 'mixed', partial: false },
  { mode: 'mixed', partial: true },
  { mode: 'ordinary', partial: true },
  { mode: 'moved', partial: true },
  { mode: 'ordinary-first', partial: false }
])(
  'preserves personal recovery and committed prefix $mode partial=$partial',
  async ({ mode, partial }) => {
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    let release = () => {}
    let blocked = ''
    const resolve = AgentSessionJournal.prototype.resolveDispatch
    const fault = vi
      .spyOn(AgentSessionJournal.prototype, 'resolveDispatch')
      .mockImplementation(function (this: AgentSessionJournal, ...args) {
        return args[0].clientMessageId === blocked
          ? Promise.reject(new Error('keep and fallback fail'))
          : resolve.apply(this, args)
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const w = await rig.workingSend()
      await openRigTurnFor(rig, w)
      const { sessions, serialize, conversationDelivery } = rig.host.collaboratorsForTests()
      release = conversationDelivery.loop['deps'].deliveryOrder.reserve(SESSION).release
      const journal = sessions.get(SESSION)!.journal
      const mixed = mode === 'mixed'
      const first = mode === 'ordinary-first' ? rig.send('M1') : undefined
      await first?.result
      await serialize(SESSION, async () => {
        await journal.queuedMessages.insert({
          messageId: 'C',
          body:
            mixed || first
              ? { ...hostTestMessage('/compact'), command: { name: 'compact' } }
              : hostTestMessage('C')
        })
        if (mixed || first) {
          await journal.queuedMessages.insert({ messageId: 'D', body: hostTestMessage('D') })
        }
      })
      const m1 = first ?? rig.send('M1')
      await m1.result
      if (mixed) {
        await rig.deleteQueued('C')
      }
      const m2 = rig.send('M2')
      await m2.result
      expect(journal.inputOrder.forced(m1.id)).toBe(mixed)
      expect(journal.inputOrder.forced(m2.id)).toBe(Boolean(first))
      expect(journal.submission(m1.id)?.handedOverAt).toBeUndefined()
      expect(journal.submission(m2.id)?.handedOverAt).toBeUndefined()
      if (partial) {
        blocked = m2.id
      }
      await rig.restartHostProcess()
      release()
      expect(await rig.submission(m1.id)).toMatchObject({ keptAsQueuedMessageId: m1.id })
      if (partial) {
        expect(await rig.submission(m2.id)).toMatchObject({ dispatchState: 'pending' })
        const reopened = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
        expect(
          reopened.queuedMessages
            .list()
            .filter((c) => c.state === 'waiting')
            .map((c) => c.messageId)
        ).toEqual(mixed ? ['D', m1.id] : [m1.id, 'C'])
        if (mode === 'moved') {
          expect(
            await rig.host
              .collaboratorsForTests()
              .serialize(SESSION, () =>
                reopened.queuedMessages.move({ messageId: 'C', beforeMessageId: m1.id })
              )
          ).toMatchObject({ status: 'moved' })
        }
        blocked = ''
        await rig.restartHostProcess()
      }
      expect(await rig.submission(m2.id)).toMatchObject({ keptAsQueuedMessageId: m2.id })
      const reopened = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const expected = mixed
        ? ['D', m1.id, m2.id]
        : first
          ? [m1.id, 'C', 'D', m2.id]
          : mode === 'moved'
            ? ['C', m1.id, m2.id]
            : [m1.id, m2.id, 'C']
      const cards = reopened.queuedMessages.list().filter((c) => c.state === 'waiting')
      expect(cards.map((c) => c.messageId)).toEqual(expected)
      expect(
        cards.every(
          (c, i) => Number.isFinite(c.position) && (i === 0 || c.position > cards[i - 1].position)
        )
      ).toBe(true)
      expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
      const actual: string[] = []
      for (const id of expected) {
        if (first && id === 'C') {
          await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
          rig.finishCompact()
          actual.push(id)
          continue
        }
        await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
        const handoff = await rig.handoffId(id)
        actual.push((await rig.submission(handoff))!.queuedMessageId!)
        await rig.settleAccepted(handoff, `frontier-${actual.length}`)
        expect(await rig.submission(handoff)).toMatchObject({ dispatchState: 'accepted' })
      }
      expect(actual).toEqual(expected)
      expect(reopened.queuedMessages.list().filter((c) => c.state === 'waiting')).toEqual([])
      expect(reopened.queuedMessages.displayState().inputEntries.size).toBe(0)
      expect(rig.dispatch.mock.calls.filter(([i]) => i.clientMessageId === w)).toHaveLength(1)
    } finally {
      blocked = ''
      release()
      fault.mockRestore()
      warn.mockRestore()
      await rig.dispose()
    }
  }
)

it('retains an automatic unentered link through two production replacements and its real reservation release', async () => {
  const rig = await createQueuedMessageTestRig()
  let release = () => {}
  try {
    const w = await rig.workingSend()
    await openRigTurnFor(rig, w)
    const { sessions, serialize, conversationDelivery } = rig.host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    await serialize(SESSION, async () => {
      await journal.queuedMessages.insert({
        messageId: 'C',
        body: { ...hostTestMessage('/compact'), command: { name: 'compact' } }
      })
      await journal.queuedMessages.insert({
        messageId: 'D',
        body: hostTestMessage('latest D'),
        options: { effort: 'high' }
      })
    })
    const m = rig.send('M')
    await m.result
    const receipt = rig.store.readCommandReceipt({ kind: 'global' }, m.id)
    const intro = journal.inputOrder.lineage.cards.get('D')!.introduced
    await rig.deleteQueued('C')
    const reservation = conversationDelivery.loop['deps'].deliveryOrder.reserve(SESSION)
    release = reservation.release
    await rig.settleAccepted(w, 'W')
    await openRigTurnFor(rig, w, 'interrupted')
    await eventually(async () => expect((await rig.handoff('D'))?.dispatchState).toBe('pending'))
    const h = await rig.handoffId('D')
    expect((await rig.submission(h))?.handedOverAt).toBeUndefined()
    for (let i = 0; i < 2; i++) {
      await serialize(SESSION, () =>
        journal.replaceEpochItems('unreconcilable_prefix', 1, []).then(() => {})
      )
      expect(journal.inputOrder.lineage.cards.get('D')!.introduced).toBe(intro)
      expect(journal.queuedMessages.get('D')).toMatchObject({
        state: 'dispatched',
        consumedAs: h,
        body: hostTestMessage('latest D'),
        options: { effort: 'high' }
      })
      expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
        kind: 'submission',
        submission: { clientMessageId: h }
      })
      const replay = loadTestJournal(rig.root, SESSION)!
      expect(replay.damage).toBeNull()
      expect(journalInputOrder(replay.state).lineage.cards.get('D')!.introduced).toBe(intro)
      expect(
        journalInputOrder(replay.state).precedes(
          replay.state.queue.cards.get('D')!,
          replay.state.submissions.get(m.id)!
        )
      ).toBe(true)
      expect(rig.store.readCommandReceipt({ kind: 'global' }, m.id)).toEqual(receipt)
    }
    release()
    await eventually(async () => expect((await rig.submission(h))?.handedOverAt).toBeDefined())
    await rig.settleAccepted(h, 'H')
    await eventually(async () => expect((await rig.submission(m.id))?.handedOverAt).toBeDefined())
    await rig.settleAccepted(m.id, 'M')
    expect(rig.dispatch.mock.calls.map(([i]) => i.clientMessageId)).toEqual([w, h, m.id])
    expect(await rig.submission(h)).toMatchObject({ dispatchState: 'accepted' })
    expect(await rig.submission(m.id)).toMatchObject({ dispatchState: 'accepted' })
    expect(journal.queuedMessages.displayState().inputEntries.size).toBe(0)
    expect(loadTestJournal(rig.root, SESSION)!.state.inputEntries.size).toBe(0)
  } finally {
    release()
    await rig.dispose()
  }
})

it.each([10, 100])(
  'preserves initial legacy terminal gaps through replacement and actual recovery N=%i',
  async (n) => {
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      legacyInputs: true,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    try {
      const original = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      await rig.host.flushAllStreamedEvents()
      writeLegacyGapFixture(rig.root, original, n)
      const check = (state: JournalReducerState) => {
        const m = state.submissions.get('legacy-M')!
        expect.soft(journalInputOrder(state).forced('legacy-M')).toBe(true)
        expect
          .soft(
            ['C', 'D'].map((id) => journalInputOrder(state).precedes(state.queue.cards.get(id)!, m))
          )
          .toEqual([true, true])
      }
      check(loadTestJournal(rig.root, SESSION)!.state)
      const journal = new AgentSessionJournal({
        identity: original['identity'],
        database: openTestJournalHostDatabase(rig.root)
      })
      await journal.open()
      for (let pass = 0; pass < 2; pass++) {
        await journal.replaceEpochItems('unreconcilable_prefix', 1, [])
        check(journal.queuedMessages.displayState())
        check(loadTestJournal(rig.root, SESSION)!.state)
      }
      await journal.close()
      rig.crashRestartHostProcess()
      await rig.submission('legacy-M')
      const reopened = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const saved = reopened.queuedMessages
        .list()
        .filter((c) => c.state === 'waiting')
        .map((c) => c.messageId)
      expect.soft(saved).toEqual(['C', 'D', 'legacy-M'])
      expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
      const delivered: string[] = []
      for (const id of saved) {
        if (id === 'C') {
          await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
          rig.finishCompact()
          delivered.push(id)
          continue
        }
        await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
        const h = await rig.handoffId(id)
        await rig.settleAccepted(h, id)
        delivered.push(id)
        expect(await rig.submission(h)).toMatchObject({
          dispatchState: 'accepted',
          queuedMessageId: id
        })
      }
      expect.soft(delivered).toEqual(['C', 'D', 'legacy-M'])
      expect
        .soft(
          rig.dispatch.mock.calls.map(
            ([input]) => reopened.submission(input.clientMessageId)?.queuedMessageId
          )
        )
        .toEqual(['D', 'legacy-M'])
      expect(reopened.queuedMessages.list().filter((c) => c.state === 'waiting')).toEqual([])
      expect(reopened.queuedMessages.displayState().inputEntries.size).toBe(0)
      expect(loadTestJournal(rig.root, SESSION)!.state.inputEntries.size).toBe(0)
      expect([...reopened.inputOrder.lineage.cards.values()].every((c) => !c.baseline)).toBe(true)
    } finally {
      await rig.dispose()
    }
  }
)
