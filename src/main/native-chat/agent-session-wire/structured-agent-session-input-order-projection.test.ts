import { expect, it, vi } from 'vitest'
import { JournalInputOrder } from '../agent-session-journal/journal-input-order'
import * as provenance from '../agent-session-journal/journal-input-provenance'
import {
  openTestJournalHostDatabase,
  loadTestJournal
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
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'

it.each([10, 100])(
  'counts real projection mutations, replay, replacement and recovery N=%i',
  async (n) => {
    type Counts = {
      rows: number
      kinds: Record<string, number>
      rebuilds: number
      submissionVisits: number
      queueVisits: number
      pruneVisits: number
      targetVisits: number
      receiptQueries: number
      maxS: number
      maxQ: number
      maxU: number
      maxP: number
      maxPrefixReferences: number
      maxPrefixBacking: number
    }
    const phases: Record<string, Counts> = {}
    let phase = 'warm'
    const metric = () =>
      (phases[phase] ??= {
        rows: 0,
        kinds: {},
        rebuilds: 0,
        submissionVisits: 0,
        queueVisits: 0,
        pruneVisits: 0,
        targetVisits: 0,
        receiptQueries: 0,
        maxS: 0,
        maxQ: 0,
        maxU: 0,
        maxP: 0,
        maxPrefixReferences: 0,
        maxPrefixBacking: 0
      })
    const before = JournalInputOrder.prototype.beforeRow
    const after = JournalInputOrder.prototype.afterRow
    const beforeSpy = vi
      .spyOn(JournalInputOrder.prototype, 'beforeRow')
      .mockImplementation(function (this: JournalInputOrder, state, row) {
        const m = metric()
        m.rows++
        m.kinds[row.kind] = (m.kinds[row.kind] ?? 0) + 1
        const values = state.queue.cards.values.bind(state.queue.cards)
        const visit = vi.spyOn(state.queue.cards, 'values').mockImplementation(function* () {
          for (const card of values()) {
            m.queueVisits++
            yield card
          }
        })
        try {
          return before.call(this, state, row)
        } finally {
          visit.mockRestore()
        }
      })
    const afterSpy = vi.spyOn(JournalInputOrder.prototype, 'afterRow').mockImplementation(function (
      this: JournalInputOrder,
      state,
      row
    ) {
      const m = metric()
      const values = state.submissions.values.bind(state.submissions)
      const entries = vi.spyOn(state.submissions, 'values').mockImplementation(function* () {
        m.rebuilds++
        for (const entry of values()) {
          m.submissionVisits++
          yield entry
        }
      })
      const get = state.submissions.get.bind(state.submissions)
      const targets = vi.spyOn(state.submissions, 'get').mockImplementation((id) => {
        m.targetVisits++
        return get(id)
      })
      const prefixes = this['prefixes']
      const keys = prefixes.keys.bind(prefixes)
      const prune = vi.spyOn(prefixes, 'keys').mockImplementation(function* () {
        for (const id of keys()) {
          m.pruneVisits++
          yield id
        }
      })
      try {
        return after.call(this, state, row)
      } finally {
        entries.mockRestore()
        prune.mockRestore()
        targets.mockRestore()
        m.maxS = Math.max(m.maxS, state.submissions.size)
        m.maxQ = Math.max(m.maxQ, state.queue.cards.size)
        m.maxU = Math.max(m.maxU, this.unsettledSubmissions().length)
        m.maxP = Math.max(m.maxP, prefixes.size)
        m.maxPrefixBacking = Math.max(
          m.maxPrefixBacking,
          [...new Set(prefixes.values())].reduce((sum, p) => sum + p.length, 0)
        )
        m.maxPrefixReferences = Math.max(
          m.maxPrefixReferences,
          [...prefixes.values()].reduce((sum, p) => sum + p.length, 0)
        )
      }
    })
    const lookup = provenance.journalInputAcceptance
    const receiptSpy = vi
      .spyOn(provenance, 'journalInputAcceptance')
      .mockImplementation((...args) => {
        metric().receiptQueries++
        return lookup(...args)
      })
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    let result: unknown
    try {
      const w = await rig.workingSend()
      await openRigTurnFor(rig, w)
      const { serialize, sessions } = rig.host.collaboratorsForTests()
      const journal = sessions.get(SESSION)!.journal
      phase = 'terminal-history'
      for (let i = 0; i < n; i++) {
        await serialize(SESSION, async () => {
          await journal.appendSubmission({
            clientMessageId: `history-${i}`,
            body: hostTestMessage('old'),
            payloadFingerprint: `history-${i}`,
            fence: 1,
            handoverRecorded: true,
            origin: 'client'
          })
          await journal.resolveDispatch({
            clientMessageId: `history-${i}`,
            state: 'accepted',
            providerIdentity: null,
            fence: 1
          })
        })
      }
      expect(metric().maxU).toBe(2)
      expect(metric().maxP).toBe(0)
      expect(metric().submissionVisits).toBe(0)
      expect(metric().targetVisits).toBe(2 * n)
      phase = 'queue'
      await serialize(SESSION, async () => {
        for (let i = 0; i < n; i++) {
          await journal.queuedMessages.insert({
            messageId: `Q${i}`,
            body:
              i === 0
                ? { ...hostTestMessage('/compact'), command: { name: 'compact' } }
                : hostTestMessage(`card-${i}`)
          })
        }
      })
      expect(metric().rebuilds).toBe(0)
      phase = 'admissions'
      const ids: string[] = []
      for (let i = 0; i < n; i++) {
        const m = rig.send(`forced-${i}`)
        ids.push(m.id)
        expect(await m.result).toMatchObject({ ok: true })
      }
      await serialize(SESSION, async () => {})
      expect(metric().rebuilds).toBe(0)
      expect(metric().submissionVisits).toBe(0)
      expect(metric().targetVisits).toBe(n)
      expect(metric().queueVisits).toBe(n)
      expect(metric().maxPrefixReferences).toBe(n * n)
      expect(metric().maxPrefixBacking).toBe(n)
      expect(metric().receiptQueries).toBe(0)
      expect(journal.inputOrder.prefix(ids[0]).map((c) => c.messageId)).toEqual(
        Array.from({ length: n }, (_, i) => `Q${i}`)
      )
      phase = 'tombstones'
      for (let i = 0; i < n; i++) {
        await serialize(SESSION, () => journal.appendQueueResume(1).then(() => {}))
      }
      expect(metric().rebuilds).toBe(0)
      expect(metric().submissionVisits).toBe(0)
      expect(metric().pruneVisits).toBe(0)
      expect(metric().targetVisits).toBe(0)
      phase = 'pause-sharing-control'
      await serialize(SESSION, async () => {
        await journal.appendSubmission({
          clientMessageId: 'same-context',
          body: hostTestMessage('same-context'),
          payloadFingerprint: 'same-context',
          fence: 1,
          handoverRecorded: true,
          origin: 'client'
        })
        expect(journal.inputOrder.prefix('same-context')).toBe(journal.inputOrder.prefix(ids[0]))
        await journal.resolveDispatch({
          clientMessageId: 'same-context',
          state: 'accepted',
          providerIdentity: null,
          fence: 1
        })
        expect(journal.inputOrder.prefix('same-context')).toEqual([])
      })
      expect(metric().queueVisits).toBe(n)
      expect(metric().maxPrefixBacking).toBe(n)
      phase = 'edits'
      const revision = journal.inputOrder.version()
      const pauses = vi.spyOn(journal.queuedMessages, 'pauses')
      const selectorCounts = {
        owedFilterVisits: 0,
        prefixSomeVisits: 0,
        pendingFindVisits: 0,
        pendingIteratorVisits: 0,
        prefixIndexVisits: 0,
        membershipQueries: 0
      }
      const pendingFindSpies: { mockRestore(): void }[] = []
      const owed = journal.inputOrder.unsettledSubmissions()
      const filter = owed.filter.bind(owed)
      const filterSpy = vi.spyOn(owed, 'filter').mockImplementation((predicate, receiver) => {
        const filtered = filter((...args) => {
          selectorCounts.owedFilterVisits++
          return predicate.apply(receiver, args)
        })
        const iterator = filtered[Symbol.iterator].bind(filtered)
        pendingFindSpies.push(
          vi.spyOn(filtered, Symbol.iterator).mockImplementation(function* () {
            for (const entry of iterator()) {
              selectorCounts.pendingIteratorVisits++
              yield entry
            }
          })
        )
        const find = filtered.find.bind(filtered)
        pendingFindSpies.push(
          vi.spyOn(filtered, 'find').mockImplementation((predicate, receiver) =>
            find((...args) => {
              selectorCounts.pendingFindVisits++
              return predicate.apply(receiver, args)
            })
          )
        )
        return filtered
      })
      const prefix = journal.inputOrder.prefix(ids[0])
      const map = prefix.map.bind(prefix)
      const mapSpy = vi.spyOn(prefix, 'map').mockImplementation((fn, receiver) =>
        map((...args) => {
          selectorCounts.prefixIndexVisits++
          return fn.apply(receiver, args)
        })
      )
      const precedes = journal.inputOrder.precedes.bind(journal.inputOrder)
      const membershipSpy = vi
        .spyOn(journal.inputOrder, 'precedes')
        .mockImplementation((...args) => {
          selectorCounts.membershipQueries++
          return precedes(...args)
        })
      // Exercise one cold index construction, then reuse it across every edit miss.
      journal.inputOrder['memberships'].delete(prefix)
      const some = prefix.some.bind(prefix)
      const someSpy = vi.spyOn(prefix, 'some').mockImplementation((predicate, receiver) =>
        some((...args) => {
          selectorCounts.prefixSomeVisits++
          return predicate.apply(receiver, args)
        })
      )
      for (let i = 0; i < n; i++) {
        const key = { callerKey: 'projection', editId: `edit-${i}` }
        const card = journal.queuedMessages.get('Q0')!
        expect(
          journal.queuedMessages.editLeases.acquire(key, {
            messageId: 'Q0',
            fingerprint: card.fingerprint
          }).status
        ).toBe('held')
        expect(selectStructuredAgentSessionInput(journal).kind).toBe('none')
        journal.queuedMessages.editLeases.release(key, 'Q0')
        expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
          kind: 'card',
          card: { messageId: 'Q0' }
        })
        selectStructuredAgentSessionInput(journal)
      }
      const editSelectionPauseReads = pauses.mock.calls.length
      expect(editSelectionPauseReads).toBe(2 * n)
      expect(selectorCounts.owedFilterVisits).toBe(2 * n * (n + 1))
      expect(selectorCounts.prefixSomeVisits).toBe(0)
      // Each miss visits current U once for override/index and Q once for membership.
      expect(selectorCounts.pendingFindVisits).toBe(2 * n * n)
      expect(selectorCounts.pendingIteratorVisits).toBe(2 * n * n)
      expect(selectorCounts.membershipQueries).toBe(2 * n * n)
      expect(selectorCounts.prefixIndexVisits).toBe(n)
      expect(journal.inputOrder.version()).toBe(revision)
      expect(metric().rows).toBe(0)
      pauses.mockRestore()
      filterSpy.mockRestore()
      someSpy.mockRestore()
      mapSpy.mockRestore()
      membershipSpy.mockRestore()
      pendingFindSpies.forEach((spy) => spy.mockRestore())
      // Isolate folds from asynchronous host delivery; a fresh host resumes actual delivery below.
      rig.host.stopDelivery()
      phase = 'replacement'
      await serialize(SESSION, () =>
        journal.replaceEpochItems('unreconcilable_prefix', 1, []).then(() => {})
      )
      expect(
        journal.inputOrder.unsettledSubmissions().filter((s) => ids.includes(s.clientMessageId))
      ).toHaveLength(n)
      expect(metric().kinds.submission).toBe(n)
      // Q staged cards, Q withdrawals, Q canonical cards, U submissions, epoch and Resume.
      expect(metric().rows).toBe(4 * n + 2)
      expect(metric().queueVisits).toBe(n)
      phase = 'replay'
      const loaded = loadTestJournal(rig.root, SESSION)!
      expect(loaded.damage).toBeNull()
      expect(loaded.newer).toBeNull()
      expect(metric().rows).toBe(phases.replacement.rows)
      expect(metric().submissionVisits).toBe(phases.replacement.submissionVisits)
      expect(loaded.state.inputOrder.prefix(ids[0])).toHaveLength(n)
      phase = 'receipt-positive-control'
      provenance.journalInputAcceptance(openTestJournalHostDatabase(rig.root).db, SESSION, ids[0])
      expect(metric().receiptQueries).toBe(1)
      phase = 'restart-recovery'
      await rig.restartHostProcess()
      for (const id of ids) {
        expect(await rig.submission(id)).toMatchObject({
          dispatchState: 'rejected',
          keptAsQueuedMessageId: id
        })
      }
      const reopened = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      expect(
        reopened.inputOrder.unsettledSubmissions().filter((s) => ids.includes(s.clientMessageId))
      ).toEqual([])
      for (const id of ids) {
        expect(reopened.inputOrder.prefix(id)).toEqual([])
      }
      expect(reopened.queuedMessages.editLeases.heldIds().size).toBe(0)
      expect((await rig.drafts()).map((c) => c.messageId)).toEqual([
        ...Array.from({ length: n }, (_, i) => `Q${i}`),
        ...ids
      ])
      phase = 'actual-delivery'
      expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
      await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
      const command = rig.compact.mock.calls[0]![0].command
      expect(await rig.handoff(ids[0])).toBeUndefined()
      rig.finishCompact()
      await eventually(() =>
        expect(reopened.item(agentJournalItemKey(command.identity))?.body).toMatchObject({
          kind: 'turn',
          state: 'completed'
        })
      )
      for (const card of [...Array.from({ length: n - 1 }, (_, i) => `Q${i + 1}`), ...ids]) {
        await eventually(async () => expect((await rig.handoff(card))?.handedOverAt).toBeDefined())
        const id = await rig.handoffId(card)
        await rig.settleAccepted(id, card)
        expect(reopened.inputOrder.prefix(id)).toEqual([])
      }
      expect(metric().submissionVisits).toBe(0)
      expect(metric().pruneVisits).toBe(0)
      expect(metric().maxU).toBe(1)
      expect(metric().maxP).toBe(0)
      expect(reopened.inputOrder.unsettledSubmissions()).toEqual([])
      expect(reopened.queuedMessages.list().filter((c) => c.state === 'waiting')).toEqual([])
      result = { n, phases, editSelectionPauseReads, selectorCounts, complete: true }
    } finally {
      result ??= { n, phases, failedDuring: phase }
      console.info('projection-counts', JSON.stringify(result))
      phase = 'cleanup'
      await rig.dispose()
      receiptSpy.mockRestore()
      beforeSpy.mockRestore()
      afterSpy.mockRestore()
    }
  }
)
