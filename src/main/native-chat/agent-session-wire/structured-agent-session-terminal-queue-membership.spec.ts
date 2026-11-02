import * as reducer from '../agent-session-journal/journal-reducer'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { withStoppedHistory } from '../../../shared/agent-session/lifecycle/agent-session-stopped-history'
import { carriedStoppedHistory } from './structured-agent-session-stopped-history-selection'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'
import { holdUnsentSends } from '../agent-session-journal/journal-unsent-send-hold'
import { JournalOutcomeCompaction } from '../agent-session-journal/journal-outcome-compaction'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import * as transitions from '../agent-session-journal/journal-reducer-transition'
import { JournalInputOrder } from '../agent-session-journal/journal-input-order'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { expect, it, vi } from 'vitest'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { JournalInputCardIndex } from '../agent-session-journal/journal-input-card-index'
import { JournalInputPlaceIndex } from '../agent-session-journal/journal-input-place-index'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { selectStructuredAgentSessionInput } from './structured-agent-session-input-selection'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW,
  HOST_TEST_THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'

it.each([10, 100])(
  'bounds current queue work independently of retained terminal cards H=%i',
  async (h) => {
    const failures = vi.fn()
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      onRequestFailure: failures,
      now: (() => {
        let t = HOST_TEST_NOW
        return () => ++t
      })()
    })
    type Counts = {
      archived: number
      records: number
      indexed: number
      restores: number
      nodes: number
      drafts: number
      points: number
      paths: number
      endpoints: number
      statusRecords: number
      statusItems: number
    }
    const phases: Record<string, Counts> = {}
    let phase = 'setup'
    const count = () =>
      (phases[phase] ??= {
        archived: 0,
        records: 0,
        indexed: 0,
        restores: 0,
        nodes: 0,
        drafts: 0,
        points: 0,
        paths: 0,
        endpoints: 0,
        statusRecords: 0,
        statusItems: 0
      })
    const archived = (id: unknown) =>
      typeof id === 'string' && /^archive-(withdrawn|sent|input)-/.test(id)
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item)
        }
        return
      }
      if (typeof value === 'string') {
        if (archived(value)) {
          count().archived++
        }
        return
      }
      if (!value || typeof value !== 'object') {
        return
      }
      const id =
        'messageId' in value
          ? value.messageId
          : 'clientMessageId' in value
            ? value.clientMessageId
            : 'card' in value &&
                value.card &&
                typeof value.card === 'object' &&
                'messageId' in value.card
              ? value.card.messageId
              : undefined
      if (typeof id === 'string') {
        count().records++
        if (archived(id)) {
          count().archived++
        }
      }
    }
    const values = Map.prototype.values,
      keys = Map.prototype.keys,
      entries = Map.prototype.entries
    const mv = vi.spyOn(Map.prototype, 'values').mockImplementation(function* () {
      for (const value of values.call(this)) {
        visit(value)
        yield value
      }
      return undefined
    })
    const mk = vi.spyOn(Map.prototype, 'keys').mockImplementation(function* () {
      for (const key of keys.call(this)) {
        visit(key)
        yield key
      }
      return undefined
    })
    const me = vi.spyOn(Map.prototype, 'entries').mockImplementation(function* () {
      for (const entry of entries.call(this)) {
        visit(entry)
        yield entry
      }
      return undefined
    })
    const mi = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* () {
      for (const entry of entries.call(this)) {
        visit(entry)
        yield entry
      }
      return undefined
    })
    const mf = vi.spyOn(Map.prototype, 'forEach').mockImplementation(function (callback, receiver) {
      for (const [key, value] of entries.call(this)) {
        visit([key, value])
        callback.call(receiver, value, key, this)
      }
    })
    type Tree = NonNullable<JournalInputPlaceIndex['all']>
    let querying = 0
    const observeNode = (node: Tree | undefined): Tree | undefined =>
      node &&
      new Proxy(node, {
        get(target, key, receiver) {
          count().paths++
          const value = Reflect.get(target, key, receiver)
          return key === 'left' || key === 'right' ? observeNode(value) : value
        }
      })
    const atPath = <T>(index: JournalInputPlaceIndex, run: () => T): T => {
      const root = index['all']
      index['all'] = observeNode(root)
      try {
        return run()
      } finally {
        index['all'] = root
      }
    }
    const firstPosition = JournalInputPlaceIndex.prototype.firstPosition
    const lastId = JournalInputPlaceIndex.prototype.lastId
    const successorId = JournalInputPlaceIndex.prototype.successorId
    const pathSpies = [
      vi.spyOn(JournalInputPlaceIndex.prototype, 'firstPosition').mockImplementation(function (
        this: JournalInputPlaceIndex
      ) {
        return atPath(this, () => firstPosition.call(this))
      }),
      vi.spyOn(JournalInputPlaceIndex.prototype, 'lastId').mockImplementation(function (
        this: JournalInputPlaceIndex
      ) {
        return atPath(this, () => lastId.call(this))
      }),
      vi.spyOn(JournalInputPlaceIndex.prototype, 'successorId').mockImplementation(function (
        this: JournalInputPlaceIndex,
        sequence
      ) {
        return atPath(this, () => successorId.call(this, sequence))
      })
    ]
    const query = JournalInputPlaceIndex.prototype.query
    const queries = vi
      .spyOn(JournalInputPlaceIndex.prototype, 'query')
      .mockImplementation(function (this: JournalInputPlaceIndex, ...args) {
        querying++
        try {
          return query.apply(this, args)
        } finally {
          querying--
        }
      })
    const status = JournalInputOrder.prototype.statusInputs
    const statuses = vi
      .spyOn(JournalInputOrder.prototype, 'statusInputs')
      .mockImplementation(function (this: JournalInputOrder, ...args) {
        const result = status.apply(this, args)
        return new Proxy(result, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver)
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              count().statusRecords++
              if (value && archived(value.clientMessageId)) {
                count().endpoints++
              }
            }
            return value
          }
        })
      })
    const renderItems = reducer.renderJournalItems
    const rendered = vi.spyOn(reducer, 'renderJournalItems').mockImplementation(
      (...args) =>
        new Proxy(renderItems(...args), {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              count().statusItems++
            }
            return Reflect.get(target, key, receiver)
          }
        })
    )
    const get = Map.prototype.get
    const mg = vi.spyOn(Map.prototype, 'get').mockImplementation(function (key) {
      if (archived(key)) {
        count().points++
      }
      const value = get.call(this, key)
      return querying && value && typeof value === 'object' && 'height' in value && 'entry' in value
        ? observeNode(value)
        : value
    })
    const list = JournalQueuedMessages.prototype.list
    const lists = vi.spyOn(JournalQueuedMessages.prototype, 'list').mockImplementation(function (
      this: JournalQueuedMessages
    ) {
      return new Proxy(list.call(this), {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver)
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            visit(value)
          }
          return value
        }
      })
    })
    const index = JournalInputCardIndex.prototype.indexCard
    const indexed = vi
      .spyOn(JournalInputCardIndex.prototype, 'indexCard')
      .mockImplementation(function (this: JournalInputCardIndex, ...args) {
        count().indexed++
        visit(args[1])
        return index.apply(this, args)
      })
    const restore = JournalInputOrder.prototype.restore
    const restores = vi.spyOn(JournalInputOrder.prototype, 'restore').mockImplementation(function (
      this: JournalInputOrder,
      ...args
    ) {
      count().restores++
      return restore.apply(this, args)
    })
    const reflect = Reflect.get
    const nodes = vi.spyOn(Reflect, 'get').mockImplementation((...args) => {
      if ('height' in args[0] && 'entry' in args[0]) {
        count().nodes++
      }
      return reflect(...args)
    })
    const isolate = transitions.isolateJournalTransition
    const drafts = vi
      .spyOn(transitions, 'isolateJournalTransition')
      .mockImplementation((...args) => {
        const draft = isolate(...args)
        return {
          ...draft,
          adopt: () => {
            const result = draft.adopt()
            count().drafts += draft.trackedDerived()
            return result
          }
        }
      })
    try {
      const original = await rig.workingSend()
      rig.host.stopDelivery() // Freeze provider/drain scheduling; all following queue triggers are real writes.
      let journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const physical = journal.physicalCursor().epoch
      const fence = () => rig.store.getRecord(SESSION)!.lease.runtimeFence
      const gate = () =>
        structuredQueueSendGate(
          { store: rig.store, sessions: rig.host.collaboratorsForTests().sessions },
          SESSION
        )
      const publication = () => {
        selectStructuredAgentSessionInput(journal)
        return readQueuePublication(journal, gate())
      }
      const lane = <T>(run: () => Promise<T>) =>
        rig.host.collaboratorsForTests().serialize(SESSION, run)
      const insert = async (id: string, held = false) => {
        const body = hostTestMessage(id)
        expect(queuedMessagesPublishedBytesRefusal(journal, body, true)).toBeNull()
        const cursor = journal.cursor()
        await lane(() =>
          journal.queuedMessages.insert({
            messageId: id,
            body,
            ...(held ? { holdReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED } : {})
          })
        )
        expect(journal.cursor().sequence).toBeGreaterThan(cursor.sequence)
      }
      for (let i = 0; i < h; i++) {
        const id = `archive-withdrawn-${i}`
        await insert(id)
        expect(await rig.deleteQueued(id)).toMatchObject({ ok: true })
        if (i % 2 === 0) {
          await lane(() => journal.replaceEpochItems('unreconcilable_prefix', fence(), []))
        }
        const sent = `archive-sent-${i}`,
          input = `archive-input-${i}`
        await insert(sent)
        const row = journal.queuedMessages.get(sent)!
        await lane(() =>
          journal.appendSubmission(
            {
              clientMessageId: input,
              body: row.body,
              payloadFingerprint: row.fingerprint,
              fence: fence(),
              handoverRecorded: true
            },
            { messageId: sent, expect: 'waiting' }
          )
        )
        await lane(() =>
          journal.resolveDispatch({
            clientMessageId: input,
            state: 'pending',
            turnScope: AGENT_JOURNAL_THREAD_SCOPE,
            fence: fence()
          })
        )
        await lane(() =>
          journal.resolveDispatch({
            clientMessageId: input,
            state: 'accepted',
            providerIdentity: { provider: 'orca', clientMessageId: `accepted-${i}` },
            fence: fence()
          })
        )
      }
      await lane(() => journal.replaceEpochItems('unreconcilable_prefix', fence(), []))
      expect(journal.physicalCursor().epoch).toBe(physical)
      const raw = journal.queuedMessages.displayState()
      expect(
        [...raw.queue.cards.values()].filter(
          (card) => card.messageId.startsWith('archive-withdrawn-') && card.state === 'withdrawn'
        )
      ).toHaveLength(h)
      expect(
        [...raw.queue.cards.values()].filter(
          (card) => card.messageId.startsWith('archive-sent-') && card.state === 'dispatched'
        )
      ).toHaveLength(h)
      expect(journal.queuedMessages.list()).toEqual([])
      publication()
      let stopped: { clientMessageId: string; words: string }[] = []
      let acceptedKey = `archive-input-${h - 1}`
      const run = async (name: string, action: () => Promise<void>) => {
        phase = name
        count()
        await action()
        publication()
        expect(newestAcceptedSendKey(journal.epoch, journal.statusRead().submissions)).toBe(
          `${journal.epoch}:${acceptedKey}`
        )
        expect(
          carriedStoppedHistory(
            { journal },
            AGENT_JOURNAL_THREAD_SCOPE,
            journal.submission(original)!,
            hostTestMessage('next human')
          )
        ).toEqual(
          stopped.length
            ? { messages: stopped, covers: stopped.map((s) => s.clientMessageId) }
            : null
        )
        phase = 'between'
      }
      for (const l of [0, 1]) {
        phase = 'baseline'
        const baseline = l ? [`baseline-${l}`] : []
        if (l) {
          await insert(baseline[0])
          await lane(() =>
            journal.queuedMessages.hold({
              messageIds: baseline,
              reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
            })
          )
        }
        const check = (ids: string[]) => {
          const view = publication().queuedMessages
          expect(view.map((card) => card.messageId)).toEqual(ids)
          for (const card of view) {
            expect(card.body).toEqual(journal.queuedMessages.get(card.messageId)!.body)
          }
          if (l) {
            expect(view.find((card) => card.messageId === baseline[0])?.paused).toBe(true)
          }
        }
        const cycle = async (id: string, edit = false) => {
          const before = publication()
          await insert(id)
          const after = publication()
          expect(after.queuedMessages).not.toBe(before.queuedMessages)
          check([...baseline, id])
          if (edit) {
            expect(
              await lane(() =>
                journal.queuedMessages.update({
                  messageId: id,
                  expectedBodyFingerprint: journal.queuedMessages.get(id)!.fingerprint,
                  text: 'edited current',
                  images: []
                })
              )
            ).toMatchObject({ status: 'updated' })
            expect(
              publication().queuedMessages.find((card) => card.messageId === id)?.body
            ).toEqual(hostTestMessage('edited current'))
            if (l) {
              expect(
                await lane(() =>
                  journal.queuedMessages.move({ messageId: id, beforeMessageId: baseline[0] })
                )
              ).toMatchObject({ status: 'moved' })
              check([id, ...baseline])
            }
          }
          expect(await rig.deleteQueued(id)).toMatchObject({ ok: true })
          check(baseline)
          expect(publication().queuePause).toBeNull()
        }
        await run(`cycles-${l}`, async () => {
          for (let i = 0; i < 10; i++) {
            await cycle(`cycle-${l}-${i}`, i === 0)
          }
        })
        await run(`stop-${l}`, async () => {
          const pending = rig.send(`stop pending ${l}`)
          expect(await pending.result).toMatchObject({ ok: true })
          const settled = rig.host.waitForSendSettlement(SESSION, pending.id)
          expect(await rig.stop()).toMatchObject({ ok: true })
          expect((await settled)?.value.submission.clientMessageId).toBe(pending.id)
          expect(journal.submission(pending.id)?.dispatchState).not.toBe('pending')
          stopped.push({ clientMessageId: pending.id, words: `stop pending ${l}` })
          publication()
          await insert(`after-stop-${l}`)
          publication()
          expect(await rig.deleteQueued(`after-stop-${l}`)).toMatchObject({ ok: true })
        })
        await run(`resume-${l}`, async () => {
          expect(await rig.resume()).toMatchObject({ ok: true })
          publication()
          await cycle(`after-resume-${l}`)
        })
        await run(`rewind-${l}`, async () => {
          await lane(() => journal.replaceEpochItems('unreconcilable_prefix', fence(), []))
          publication()
          await cycle(`after-rewind-${l}`)
          expect(journal.physicalCursor().epoch).toBe(physical)
        })
        await run(`recovery-${l}`, async () => {
          const beforeFailures = failures.mock.calls.length
          const id = `recovery-${l}`,
            input = `recovery-input-${l}`
          await insert(id)
          const card = journal.queuedMessages.get(id)!
          await lane(() =>
            journal.appendSubmission(
              {
                clientMessageId: input,
                origin: 'client',
                body: card.body,
                payloadFingerprint: card.fingerprint,
                handoverRecorded: true,
                fence: fence()
              },
              { messageId: id, expect: 'waiting' }
            )
          )
          const primed = journal.queuedMessages.list()
          expect(primed.map((row) => row.messageId)).toContain(id)
          const revision = journal.queuedMessages.displayState().queue.revision
          await lane(() =>
            journal.resolveDispatch({
              clientMessageId: input,
              state: 'pending',
              turnScope: AGENT_JOURNAL_THREAD_SCOPE,
              fence: fence()
            })
          )
          expect(journal.queuedMessages.displayState().queue.revision).toBe(revision)
          expect(journal.queuedMessages.list()).not.toBe(primed)
          expect(journal.queuedMessages.list().map((row) => row.messageId)).not.toContain(id)
          expect(journal.queuedMessages.awaitReopenMark()).toBe(true)
          await lane(() =>
            holdUnsentSends(journal, {
              fence: fence(),
              hold: { cause: 'chatClosed' },
              unrun: (entry) => entry.clientMessageId === input
            })
          )
          expect(journal.queuedMessages.get(id)?.body).toEqual(card.body)
          const direct = `failed-start-${l}`
          await lane(() =>
            journal.appendSubmission({
              clientMessageId: direct,
              origin: 'client',
              body: hostTestMessage(direct),
              payloadFingerprint: direct,
              handoverRecorded: true,
              fence: fence()
            })
          )
          await lane(() =>
            journal.appendLifecycleBatch({
              settlementId: direct,
              mutations: [],
              fence: fence(),
              keepFailedStart: true,
              dispatches: [
                {
                  clientMessageId: direct,
                  state: 'rejected',
                  fence: fence(),
                  ...agentSessionFailureWords(
                    agentSessionFailureFact('providerStartFailed', { neverReachedAgent: true }),
                    { surface: 'rejection' }
                  )
                }
              ]
            })
          )
          expect(
            failures.mock.calls
              .slice(beforeFailures)
              .map(([edge]) => ({ id: edge.id, outcome: edge.outcome }))
          ).toEqual([{ id: `orca:${direct}`, outcome: 'failure' }])
          expect(publication().queuedMessages[0]?.messageId).toBe(direct)
          expect(journal.queuedMessages.get(direct)?.body).toEqual(hostTestMessage(direct))
          expect(await rig.deleteQueued(direct)).toMatchObject({ ok: true })
          check(baseline)
        })
        phase = 'baseline'
        if (l) {
          expect(await rig.deleteQueued(baseline[0])).toMatchObject({ ok: true })
        }
      }
      phase = 'compaction'
      const db = openTestJournalHostDatabase(rig.root),
        compactor = new JournalOutcomeCompaction()
      let pages = 0
      while (compactor.page(db)) {
        if (++pages > 10000) {
          throw new Error('compaction did not finish')
        }
      }
      phase = 'cold-reopen'
      await rig.restartHostProcess()
      await rig.host.history({ sessionId: SESSION, direction: 'tail' })
      journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      publication()
      expect(journal.physicalCursor().epoch).toBe(physical)
      phase = 'raw-proof'
      for (let i = 0; i < h; i++) {
        expect(journal.queuedMessages.get(`archive-withdrawn-${i}`)?.state).toBe('withdrawn')
        expect(journal.queuedMessages.get(`archive-sent-${i}`)?.state).toBe('dispatched')
        expect(journal.submission(`archive-input-${i}`)?.dispatchState).toBe('accepted')
      }
      await run('after-reopen', async () => {
        await insert('after-reopen', true)
        expect(publication().queuedMessages.map((card) => card.messageId)).toEqual(['after-reopen'])
        expect(await rig.deleteQueued('after-reopen')).toMatchObject({ ok: true })
        expect(publication().queuedMessages).toEqual([])
      })
      await run('delivery', async () => {
        const before = rig.dispatch.mock.calls.length
        const next = rig.send('real delivery after reopen')
        expect(await next.result).toMatchObject({ ok: true })
        const settled = rig.host.waitForSendSettlement(SESSION, next.id)
        await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(before + 1))
        expect(journal.submission(next.id)?.handedOverAt).toBeDefined()
        expect(rig.dispatch.mock.calls.at(-1)?.[0].body).toEqual(
          withStoppedHistory(hostTestMessage('real delivery after reopen'), stopped)
        )
        await rig.host.settleLateDispatch({
          sessionId: SESSION,
          clientMessageId: next.id,
          providerIdentity: {
            provider: 'codex',
            threadId: HOST_TEST_THREAD,
            turnId: 'turn-real-delivery',
            ordinal: 0
          }
        })
        expect((await settled)?.value.submission.dispatchState).toBe('accepted')
        acceptedKey = next.id
        stopped = []
      })
      console.info('terminal-queue-membership-counts', JSON.stringify({ h, phases }))
      for (const [name, c] of Object.entries(phases)) {
        if (!/^(cycles|stop|resume|rewind|recovery)-|^(after-reopen|delivery)$/.test(name)) {
          continue
        }
        expect(c.archived, name).toBe(0)
        expect(c.restores, name).toBe(0)
        expect(c.indexed, name).toBeLessThanOrEqual(200)
        expect(c.records, name).toBeLessThanOrEqual(5000)
        expect(c.nodes, name).toBeLessThanOrEqual(10000 * Math.ceil(Math.log2(2 * h + 40)))
        expect(c.points, name).toBeLessThanOrEqual(2000)
        expect(c.endpoints, name).toBeLessThanOrEqual(2000)
        expect(c.statusRecords, name).toBeLessThanOrEqual(5000)
        expect(c.statusItems, name).toBeLessThanOrEqual(5000)
        expect(c.paths, name).toBeLessThanOrEqual(2000 * Math.ceil(Math.log2(2 * h + 40)))
        expect(c.drafts, name).toBeLessThanOrEqual(2000 * Math.ceil(Math.log2(2 * h + 40)))
      }
      expect(phases['recovery-1'].statusItems).toBeGreaterThan(0)
      expect(phases['cycles-1'].statusRecords).toBeGreaterThan(0)
      expect(phases['cycles-1'].endpoints).toBeGreaterThan(0)
      expect(phases['cold-reopen'].restores).toBeGreaterThan(0)
      expect(phases['cold-reopen'].archived).toBeGreaterThanOrEqual(2 * h)
    } finally {
      phase = 'cleanup'
      for (const spy of [
        mv,
        mk,
        me,
        mi,
        mf,
        mg,
        lists,
        indexed,
        restores,
        nodes,
        drafts,
        statuses,
        rendered,
        queries,
        ...pathSpies
      ]) {
        spy.mockRestore()
      }
      await rig.dispose()
    }
  },
  60000
)
