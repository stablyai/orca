import { expect, it, vi } from 'vitest'
import { JournalInputOrder } from '../agent-session-journal/journal-input-order'
import { JournalInputPlaceIndex } from '../agent-session-journal/journal-input-place-index'
import { JournalInputDomainIndex } from '../agent-session-journal/journal-input-domain-index'
import { JournalInputLineageOwner } from '../agent-session-journal/journal-input-lineage'
import * as receiptTable from '../agent-session-journal/command-receipt-table'
import { loadTestJournal } from '../agent-session-journal/journal-host-database-test-support'
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
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-queued-message-wire'

it.each([10, 100])(
  'bounds actual edit/growth, replay, replacement and complete recovery N=%i',
  async (n) => {
    type Counts = {
      rows: number
      queueVisits: number
      inputVisits: number
      sets: number
      queries: number
      domains: number
      lineage: number
      receipts: number
      nodes: number
      nodeReads: number
    }
    const phases: Record<string, Counts> = {}
    let phase = 'setup'
    const metric = () =>
      (phases[phase] ??= {
        rows: 0,
        queueVisits: 0,
        inputVisits: 0,
        sets: 0,
        queries: 0,
        domains: 0,
        lineage: 0,
        receipts: 0,
        nodes: 0,
        nodeReads: 0
      })
    // Count production node reads; instrumentation discovers nodes using descriptors, never getters.
    const seen = new WeakMap<object, Map<string, unknown>>()
    const inspect = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) {
        return
      }
      const prior = seen.get(node)
      if (prior) {
        inspect(prior.get('left'))
        inspect(prior.get('right'))
        return
      }
      const values = new Map<string, unknown>()
      seen.set(node, values)
      metric().nodes++
      for (const key of ['left', 'right', 'entry', 'result', 'height']) {
        values.set(key, Object.getOwnPropertyDescriptor(node, key)?.value)
        if (key === 'left' || key === 'right') {
          inspect(values.get(key))
        }
        Object.defineProperty(node, key, {
          configurable: true,
          get: () => {
            metric().nodeReads++
            return values.get(key)
          },
          set: (next) => {
            values.set(key, next)
          }
        })
      }
    }

    const set = JournalInputPlaceIndex.prototype.set
    const indexSet = vi.spyOn(JournalInputPlaceIndex.prototype, 'set').mockImplementation(function (
      this: JournalInputPlaceIndex,
      ...args
    ) {
      metric().sets++
      set.apply(this, args)
      for (const node of this['epochs'].values()) {
        inspect(node)
      }
      inspect(this['all'])
    })
    const query = JournalInputPlaceIndex.prototype.query
    const indexQuery = vi
      .spyOn(JournalInputPlaceIndex.prototype, 'query')
      .mockImplementation(function (this: JournalInputPlaceIndex, ...args) {
        metric().queries++
        return query.apply(this, args)
      })
    const domainSet = JournalInputDomainIndex.prototype.set
    const domain = vi.spyOn(JournalInputDomainIndex.prototype, 'set').mockImplementation(function (
      this: JournalInputDomainIndex,
      ...args
    ) {
      metric().domains++
      return domainSet.apply(this, args)
    })
    const change = JournalInputLineageOwner.prototype.change
    const line = vi
      .spyOn(JournalInputLineageOwner.prototype, 'change')
      .mockImplementation(function (this: JournalInputLineageOwner, ...args) {
        metric().lineage++
        return change.apply(this, args)
      })
    const receipt = receiptTable.readCommandReceipt
    const receipts = vi.spyOn(receiptTable, 'readCommandReceipt').mockImplementation((...args) => {
      metric().receipts++
      return receipt(...args)
    })
    const before = JournalInputOrder.prototype.beforeRow
    const rows = vi.spyOn(JournalInputOrder.prototype, 'beforeRow').mockImplementation(function (
      this: JournalInputOrder,
      state,
      row
    ) {
      metric().rows++
      const values = state.queue.cards.values.bind(state.queue.cards)
      const visits = vi.spyOn(state.queue.cards, 'values').mockImplementation(function* () {
        for (const card of values()) {
          metric().queueVisits++
          yield card
        }
        return undefined
      })
      try {
        return before.call(this, state, row)
      } finally {
        visits.mockRestore()
      }
    })
    const after = JournalInputOrder.prototype.afterRow
    const folded = vi.spyOn(JournalInputOrder.prototype, 'afterRow').mockImplementation(function (
      this: JournalInputOrder,
      state,
      row
    ) {
      const values = state.submissions.values.bind(state.submissions)
      const visits = vi.spyOn(state.submissions, 'values').mockImplementation(function* () {
        for (const input of values()) {
          metric().inputVisits++
          yield input
        }
        return undefined
      })
      try {
        return after.call(this, state, row)
      } finally {
        visits.mockRestore()
      }
    })
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    try {
      const w = await rig.workingSend()
      await openRigTurnFor(rig, w)
      const { serialize, sessions } = rig.host.collaboratorsForTests()
      const journal = sessions.get(SESSION)!.journal
      const q = Array.from({ length: n }, (_, i) => `Q${i}`)
      await serialize(SESSION, async () => {
        for (const [i, id] of q.entries()) {
          await journal.queuedMessages.insert({
            messageId: id,
            body:
              i === 0
                ? { ...hostTestMessage('/compact'), command: { name: 'compact' } }
                : hostTestMessage(id)
          })
        }
        for (let i = 1; i < n; i++) {
          if (i % 3 === 0) {
            continue
          }
          const card = journal.queuedMessages.get(q[i])!
          await journal.queuedMessages['write'](() => ({
            changes: [
              {
                messageId: card.messageId,
                change: {
                  op: 'queued',
                  body: card.body,
                  position: card.position,
                  queuedAt: i % 3 === 1 ? null : { epoch: 'imported-domain', sequence: 1 }
                }
              }
            ],
            result: undefined
          }))
        }
        await journal.queuedMessages.insert({
          messageId: 'E',
          body: hostTestMessage('held'),
          holdReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
        })
      })
      phase = 'edits-growth'
      const ids: string[] = []
      for (let i = 0; i < n; i++) {
        await serialize(SESSION, async () => {
          for (const id of ['E', 'Q1']) {
            expect(
              await journal.queuedMessages.update({
                messageId: id,
                expectedBodyFingerprint: journal.queuedMessages.get(id)!.fingerprint,
                text: `${id}-edit-${i}`,
                images: []
              })
            ).toMatchObject({ status: 'updated' })
          }
          await journal.queuedMessages.insert({
            messageId: `D${i}`,
            body: hostTestMessage(`D${i}`)
          })
        })
        const m = rig.send(`M${i}`)
        ids.push(m.id)
        expect(await m.result).toMatchObject({ ok: true })
        expect(journal.inputOrder.forced(m.id)).toBe(true)
        expect(
          journal.inputOrder.precedes(
            journal.queuedMessages.get(`D${i}`)!,
            journal.submission(m.id)!
          )
        ).toBe(true)
        if (i) {
          expect(
            journal.inputOrder.precedes(
              journal.queuedMessages.get(`D${i}`)!,
              journal.submission(ids[i - 1])!
            )
          ).toBe(false)
        }
      }
      await serialize(SESSION, () =>
        journal.queuedMessages
          .insert({ messageId: 'L', body: hostTestMessage('later sentinel') })
          .then(() => {})
      )
      expect(metric().queueVisits).toBe(0)
      expect(metric().inputVisits).toBe(0)
      expect(metric().receipts).toBe(n) // Existing direct acceptance receipt read, no ordering probe.
      // Two coordinate indexes, one point per new card; body-only edits never update an order index.
      expect(metric().sets).toBe(2 * (n + 1))
      expect(metric().nodeReads).toBeLessThanOrEqual(
        200 * (n + 1) * Math.ceil(Math.log2(2 * n + 3))
      )
      expect(journal.inputOrder['places'].size).toBe(n + 1)
      expect(journal.inputOrder.lineage.cards.size).toBe(2 * n + 2)
      expect(domain).not.toHaveBeenCalled()
      for (let i = 0; i < n; i++) {
        const key = { callerKey: 'projection', editId: `lease-${i}` }
        expect(
          journal.queuedMessages.editLeases.acquire(key, {
            messageId: 'Q0',
            fingerprint: journal.queuedMessages.get('Q0')!.fingerprint
          }).status
        ).toBe('held')
        expect(selectStructuredAgentSessionInput(journal).kind).toBe('none')
        journal.queuedMessages.editLeases.release(key, 'Q0')
        expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
          kind: 'card',
          card: { messageId: 'Q0' }
        })
      }
      rig.host.stopDelivery()
      phase = 'original-replay'
      expect(loadTestJournal(rig.root, SESSION)?.damage).toBeNull()
      expect(metric().receipts).toBe(0)
      for (let pass = 0; pass < 2; pass++) {
        phase = `replacement-${pass}`
        await serialize(SESSION, () =>
          journal.replaceEpochItems('unreconcilable_prefix', 1, []).then(() => {})
        )
        expect(metric().rows).toBeLessThanOrEqual(3 * n + 8)
        expect(metric().receipts).toBe(n)
        const envelope = journal.inputOrder.replacementLineage(
          new Set(journal.queuedMessages.list().map((card) => card.messageId))
        )
        expect(
          envelope.cards.reduce((sum, card) => sum + card.aliases.length, 0)
        ).toBeLessThanOrEqual(2 * n + 4)
        phase = `output-replay-${pass}`
        const replay = loadTestJournal(rig.root, SESSION)!
        expect(replay.damage).toBeNull()
        expect(replay.newer).toBeNull()
        expect(metric().rows).toBe(phases[`replacement-${pass}`].rows)
        expect(ids.every((id) => replay.state.inputOrder.forced(id))).toBe(true)
      }
      phase = 'recovery'
      await rig.restartHostProcess()
      for (const id of ids) {
        expect(await rig.submission(id)).toMatchObject({
          dispatchState: 'rejected',
          keptAsQueuedMessageId: id
        })
      }
      const reopened = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const expected = [...q, 'E', ...ids.flatMap((id, i) => [`D${i}`, id]), 'L']
      const cards = reopened.queuedMessages.list().filter((card) => card.state === 'waiting')
      expect(cards.map((card) => card.messageId)).toEqual(expected)
      expect(
        cards.every(
          (card, i) =>
            Number.isFinite(card.position) && (i === 0 || card.position > cards[i - 1].position)
        )
      ).toBe(true)
      expect(reopened.queuedMessages.get('E')?.holdReason).toBe(QUEUED_MESSAGE_PAUSED_SEND_FAILED)
      expect(reopened.queuedMessages.get('Q1')?.body).toEqual(hostTestMessage(`Q1-edit-${n - 1}`))
      expect(reopened.inputOrder['places'].size).toBe(0)
      // A real held-card retry releases E at its existing selected Queue place.
      await rig.host.collaboratorsForTests().serialize(SESSION, () =>
        reopened.queuedMessages['write'](() => ({
          changes: [
            {
              messageId: 'E',
              change: {
                op: 'queued',
                body: reopened.queuedMessages.get('E')!.body,
                position: reopened.queuedMessages.get('E')!.position,
                queuedAt: reopened.queuedMessages.get('E')!.queuedAt
              }
            }
          ],
          result: undefined
        }))
      )
      phase = 'delivery'
      const base = rig.dispatch.mock.calls.length
      expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
      await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
      const command = rig.compact.mock.calls[0]![0].command
      rig.finishCompact()
      await eventually(() =>
        expect(reopened.item(agentJournalItemKey(command.identity))?.body).toMatchObject({
          kind: 'turn',
          state: 'completed'
        })
      )
      const actual = ['Q0']
      for (let i = 0; i < expected.length - 1; i++) {
        await eventually(() => expect(rig.dispatch.mock.calls).toHaveLength(base + i + 1))
        const input = rig.dispatch.mock.calls[base + i]![0]
        const submission = await rig.submission(input.clientMessageId)
        actual.push(submission!.queuedMessageId!)
        await rig.settleAccepted(input.clientMessageId, `actual-${i}`)
        expect(await rig.submission(input.clientMessageId)).toMatchObject({
          dispatchState: 'accepted'
        })
      }
      expect(actual).toEqual(expected)
      expect(new Set(actual).size).toBe(expected.length)
      expect(reopened.queuedMessages.list().filter((card) => card.state === 'waiting')).toEqual([])
      expect(reopened.inputOrder.unsettledSubmissions()).toEqual([])
      expect(
        rig.dispatch.mock.calls.slice(base).some(([input]) => input.clientMessageId === w)
      ).toBe(false)
      expect(reopened.inputOrder['places'].size).toBe(0)
      expect(reopened.queuedMessages.editLeases.heldIds().size).toBe(0)
      // Each folded card transition updates two current trees; recovery/pause adds a bounded bulk pass.
      // A set removes/inserts in two AVLs; rotations and summary refreshes cost a fixed number of node reads per level.
      for (const [name, count] of Object.entries(phases)) {
        expect(count.nodeReads, name).toBeLessThanOrEqual(
          200 * (count.sets + count.queries + 1) * Math.ceil(Math.log2(4 * n + 8))
        )
        expect(count.nodes, name).toBeLessThanOrEqual(2 * count.sets)
      }
      expect(phases['original-replay'].sets).toBeLessThanOrEqual(6 * n + 16)
      for (let pass = 0; pass < 2; pass++) {
        for (const name of [`replacement-${pass}`, `output-replay-${pass}`]) {
          expect(phases[name].sets, name).toBeLessThanOrEqual(4 * n + 16)
          expect(phases[name].queries, name).toBeLessThanOrEqual(n + 1)
          expect(phases[name].lineage, name).toBeLessThanOrEqual(2 * n + 4)
        }
      }
      // Per row, at most two affected-card refreshes of two indexes; two effective-pause passes may rebuild K.
      expect(phases.recovery.rows).toBeLessThanOrEqual(8 * n + 12)
      expect(phases.recovery.sets).toBeLessThanOrEqual(4 * phases.recovery.rows + 4 * (2 * n + 2))
      expect(phases.recovery.queries).toBe(2 * n)
      expect(phases.delivery.sets).toBeLessThanOrEqual(32 * n + 8)
      expect(phases.delivery.queries).toBe(0)
      console.info(
        'ordered-place-counts',
        JSON.stringify({
          n,
          phases,
          domainCalls: domain.mock.calls.length,
          lineageCalls: line.mock.calls.length,
          complete: true
        })
      )
    } finally {
      await rig.dispose()
      indexSet.mockRestore()
      indexQuery.mockRestore()
      domain.mockRestore()
      line.mockRestore()
      receipts.mockRestore()
      rows.mockRestore()
      folded.mockRestore()
    }
  },
  60_000
)
