import { journalInputOrder } from './journal-input-order'
import {
  journalInputIndexProbe,
  journalInputHistoryProbe
} from './journal-input-index-probe.test-support'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import { JournalInputPlaceIndex } from './journal-input-place-index'
import { insertCommandReceiptIfAbsent } from './command-receipt-table'
import { writeCommandReceiptTestRecord } from './command-receipt-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  claudeProviderHandle,
  agentSessionJournalProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalRow } from './journal-row-schema'
import type { JournalReducerState } from './journal-reducer'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { holdUnsentSends } from './journal-unsent-send-hold'
import {
  createTrackedJournalOpener,
  loadTestJournal,
  openTestJournalHostDatabase,
  readTestJournalOutcomes,
  insertTestJournalRow,
  writeTestLegacyTerminalGaps
} from './journal-host-database-test-support'
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

it.each([10, 100])(
  'indexes the initial legacy writer shape without promoting foreign/null comparison N=%i',
  async (n) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-legacy-baseline-'))
    const journals = createTrackedJournalOpener({ legacyInputs: true })
    const identity = {
      sessionId: 'baseline',
      workspaceId: 'folder',
      hostId: 'ssh',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    }
    let journal = await journals.open({ identity, stateDirectory: root })
    const database = openTestJournalHostDatabase(root)
    const cost = { sets: 0, queries: 0, nodes: 0, reads: 0 }
    const inspect = journalInputIndexProbe(['index', 'left', 'right'], {
      allocated: () => {
        cost.nodes++
      },
      read: () => {
        cost.reads++
      }
    })
    let inspecting = true
    const set = JournalInputDomainIndex.prototype.set
    const domainSets = vi
      .spyOn(JournalInputDomainIndex.prototype, 'set')
      .mockImplementation(function (this: JournalInputDomainIndex, ...args) {
        cost.sets++
        if (inspecting) {
          inspect(this['root'])
        }
        set.apply(this, args)
        if (inspecting) {
          inspect(this['root'])
        }
      })
    const query = JournalInputDomainIndex.prototype.query
    const domainQueries = vi
      .spyOn(JournalInputDomainIndex.prototype, 'query')
      .mockImplementation(function (this: JournalInputDomainIndex, ...args) {
        cost.queries++
        return query.apply(this, args)
      })
    const indexSets = vi.spyOn(JournalInputPlaceIndex.prototype, 'set')
    const release = journalInputHistoryProbe()
    try {
      const { epoch, sequence } = journal.cursor()
      let seq = sequence
      await journal.close()
      const base = () => ({ v: 3, epoch, seq: ++seq, fence: 0, ts: 1 })
      const queue = (
        id: string,
        queuedAt: { epoch: string; sequence: number } | null,
        command = false
      ) =>
        insertTestJournalRow(database.db, identity.sessionId, {
          ...base(),
          kind: 'queue',
          messageId: id,
          change: {
            op: 'queued',
            body: command ? { ...message('/compact'), command: { name: 'compact' } } : message(id),
            position: id === 'C' ? 1 : id === 'D' ? 2 : 3,
            queuedAt
          }
        })
      queue('C', { epoch, sequence: seq }, true)
      queue('F', { epoch: 'original-foreign', sequence: 1 })
      queue('N', null)
      database.transaction((db) => writeCommandReceiptTestRecord(db, identity.sessionId))
      const ids = Array.from({ length: n }, (_, i) => `M${i + 1}`)
      for (let i = 0; i < n; i++) {
        queue(`ordinary-${i}`, { epoch, sequence: seq })
      }
      queue('D', { epoch: 'original-foreign', sequence: 1 })
      seq = writeTestLegacyTerminalGaps(
        database.db,
        identity.sessionId,
        {
          epoch,
          sequence: seq,
          fence: 0,
          providerHandle: agentSessionJournalProviderHandle(identity)
        },
        n
      )
      for (const id of ids) {
        const target: JournalRow = {
          ...base(),
          kind: 'submission',
          clientMessageId: id,
          payloadFingerprint: id,
          body: message(id),
          providerHandle: agentSessionJournalProviderHandle(identity),
          handoverRecorded: true,
          origin: 'client'
        }
        insertTestJournalRow(database.db, identity.sessionId, target)
        if (id !== 'M2') {
          database.transaction((db) =>
            insertCommandReceiptIfAbsent(
              db,
              { kind: 'global' },
              {
                operationId: id,
                sessionId: identity.sessionId,
                callerKey: 'fixture',
                method: 'agentSession.send',
                fingerprint: id,
                status: 'accepted',
                acceptedAt: 1,
                result: { kind: 'journal-row', epoch: 'original-foreign', sequence: 100 }
              }
            )
          )
        }
      }
      queue('later-F', { epoch: 'original-foreign', sequence: 1 })
      journal = await journals.open({ identity, stateDirectory: root })
      expect(release.spy).not.toHaveBeenCalled()
      const check = (state: JournalReducerState) => {
        for (const card of ['F', 'D']) {
          expect(
            ['M1', 'M2', 'M3'].map((id) =>
              journalInputOrder(state).precedes(
                state.queue.cards.get(card)!,
                state.submissions.get(id)!
              )
            )
          ).toEqual([true, false, true])
        }
        for (const card of ['N', 'later-F']) {
          expect(
            ['M1', 'M2', 'M3'].map((id) =>
              journalInputOrder(state).precedes(
                state.queue.cards.get(card)!,
                state.submissions.get(id)!
              )
            )
          ).toEqual([false, false, false])
        }
        expect(['M1', 'M2', 'M3'].every((id) => journalInputOrder(state).forced(id))).toBe(true)
      }
      check(journal.queuedMessages.displayState())
      for (const id of ids) {
        expect(
          journal.inputOrder.predecessors(journal.queuedMessages.displayState(), id).position
        ).toBe(3)
      }
      // Accessor probes count the old raw fold only; remove them before keyed transaction drafts.
      const rawCost = { ...cost }
      expect(rawCost.nodes).toBeGreaterThan(0)
      expect(rawCost.nodes).toBeLessThanOrEqual(54 * rawCost.sets)
      expect(rawCost.reads).toBeLessThanOrEqual(4 * 54 * (rawCost.sets + rawCost.queries))
      inspect.restore()
      inspecting = false
      for (let pass = 0; pass < 3; pass++) {
        domainSets.mockClear()
        domainQueries.mockClear()
        indexSets.mockClear()
        if (pass) {
          await journal.replaceEpochItems('unreconcilable_prefix', 0, [])
        }
        check(journal.queuedMessages.displayState())
        const replay = loadTestJournal(root, identity.sessionId)!
        expect(replay.damage).toBeNull()
        check(replay.state)
        if (pass) {
          const outcomes = readTestJournalOutcomes(database.db, identity.sessionId)
          const rows = [...new Set(outcomes.map((value) => value.seq))]
          expect(rows.length).toBeLessThanOrEqual(2 * n + 12)
          const baseline = [...journal.queuedMessages.displayState().inputCards.values()].filter(
            (card) => card.baseline !== undefined
          ).length
          expect(baseline).toBeLessThanOrEqual(n + 6)
          for (const id of ids) {
            journal.inputOrder.predecessors(journal.queuedMessages.displayState(), id)
            journalInputOrder(replay.state).predecessors(replay.state, id)
          }
          expect(domainQueries).toHaveBeenCalledTimes(2 * n)
          // Each independent fold adds at most one command-witness transition beyond the frozen baseline; each update traverses at most 54 introduction nodes.
          expect(domainSets.mock.calls.length).toBeLessThanOrEqual(4 * (n + 6) + 2 * rows.length)
          expect(indexSets.mock.calls.length).toBeLessThanOrEqual(
            54 * domainSets.mock.calls.length + 8 * rows.length
          )
          console.info(
            'legacy-normalized-output',
            JSON.stringify({
              n,
              pass,
              rows: rows.length,
              baseline,
              domainSets: domainSets.mock.calls.length,
              domainQueries: domainQueries.mock.calls.length,
              indexSets: indexSets.mock.calls.length
            })
          )
        }
      }
      domainSets.mockClear()
      domainQueries.mockClear()
      indexSets.mockClear()
      await holdUnsentSends(journal, { fence: 0, hold: { cause: 'hostRestarted' } })
      expect(domainQueries).toHaveBeenCalledTimes(n)
      // One finite-rank move per current card and one keep per input, each updating its one frozen coordinate through at most 54 introduction nodes.
      expect(domainSets.mock.calls.length).toBeLessThanOrEqual(16 * (n + 6))
      expect(indexSets.mock.calls.length).toBeLessThanOrEqual(
        54 * domainSets.mock.calls.length + 16 * (n + 6)
      )
      console.info(
        'legacy-recovery-index',
        JSON.stringify({
          n,
          domainSets: domainSets.mock.calls.length,
          domainQueries: domainQueries.mock.calls.length,
          indexSets: indexSets.mock.calls.length
        })
      )
      for (const id of ids) {
        expect(journal.submission(id)).toMatchObject({
          dispatchState: 'rejected',
          keptAsQueuedMessageId: id
        })
      }
      const ranks = journal.queuedMessages
        .list()
        .filter((card) => card.state === 'waiting')
        .map((card) => card.position)
      expect(
        ranks.every((rank, i) => Number.isFinite(rank) && (i === 0 || rank > ranks[i - 1]))
      ).toBe(true)
      console.info('frozen-baseline-raw-nodes', JSON.stringify({ n, ...rawCost }))
      expect(release.spy).toHaveBeenCalledOnce()
      expect(release.visits()).toBe(2 * n + 5)
      const finished = loadTestJournal(root, identity.sessionId)!
      expect(finished.damage).toBeNull()
      expect(release.spy).toHaveBeenCalledTimes(2)
      expect(release.visits()).toBe(2 * (2 * n + 5))
      expect(
        [...journalInputOrder(finished.state).lineage.cards.values()].every(
          (card) => !card.baseline
        )
      ).toBe(true)
      expect(journal.inputOrder['cards']['domains']).toBeUndefined()
      expect(journal.queuedMessages.displayState().inputEntries.size).toBe(0)
      expect(finished.state.inputEntries.size).toBe(0)
      expect(
        [...journal.inputOrder.lineage.cards.values()].every((card) => card.baseline === undefined)
      ).toBe(true)
    } finally {
      inspect.restore()
      domainSets.mockRestore()
      domainQueries.mockRestore()
      indexSets.mockRestore()
      release.spy.mockRestore()
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
)
