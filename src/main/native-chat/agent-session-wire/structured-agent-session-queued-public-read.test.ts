import { appendTestJournalQueueRow } from '../agent-session-journal/journal-host-database-test-support'
import { expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalAnsweredTurnIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { createAgentSessionCatchUpReader } from './agent-session-history-page'
import { readPublishedQueuedMessages } from './structured-agent-session-queued-publication'
import { buildSubscriberFrame } from './agent-session-subscriber-frame-fields'
import { boundedQueuePublication } from './agent-session-bounded-queue'
import { BOUNDED_FRAME_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import {
  projectQueuedMessageCards,
  queuedMessagesQueuePause
} from '../../../shared/structured-agent-session-queued-cards'
import {
  SESSION,
  db,
  message,
  words,
  journalFor,
  seedLegacy,
  legacyIds,
  threadWrite,
  type Legacy
} from './structured-agent-session-queued-legacy-import.test-fixture'

async function handOff(
  journal: AgentSessionJournal,
  attempt: string,
  card: string,
  text: string,
  as: 'providerRejected' | 'cancelled' | 'accepted',
  fence = 0,
  beforeAnswer?: () => Promise<void>,
  answeredInTurn?: AgentJournalAnsweredTurnIdentity,
  consume = false
): Promise<void> {
  const body = message(text)
  const payloadFingerprint = agentSessionSendBodyFingerprint(journal.queuedMessages.sessionId, body)
  await journal.appendSubmission(
    {
      clientMessageId: attempt,
      payloadFingerprint,
      body,
      fence,
      handoverRecorded: true,
      queuedMessageId: card
    },
    consume ? { messageId: card, expect: 'waiting' } : undefined
  )
  await journal.resolveDispatch({
    clientMessageId: attempt,
    state: 'pending',
    fence,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await beforeAnswer?.()
  await journal.resolveDispatch(
    as === 'accepted'
      ? { clientMessageId: attempt, state: 'accepted', providerIdentity: null, fence }
      : { clientMessageId: attempt, state: 'rejected', ...words(as), fence, answeredInTurn }
  )
}

it.each([100, 1_000].flatMap((size) => [false, true].map((adopt) => ({ size, adopt }))))(
  'publication reuse: $size historical items, adopted=$adopt',
  async ({ size, adopt }) => {
    const corrections = size / 10
    const earlier = journalFor(SESSION)
    await earlier.open()
    await handOff(earlier, 'u-0', 'q-0', 'stopped words', 'cancelled', 0, async () => {
      for (let ordinal = 0; ordinal < size; ordinal++) {
        await earlier.appendItem(
          { provider: 'codex', threadId: 'history', turnId: 't', ordinal },
          { ...message('old answer'), role: 'assistant' },
          { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      }
    })
    for (let index = 1; index < corrections; index++) {
      await handOff(earlier, `u-${index}`, `q-${index}`, 'stopped words', 'cancelled')
    }
    await earlier.close()
    seedLegacy(
      SESSION,
      Array.from({ length: corrections }, (_, i): Legacy => [`q-${i}`, 'waiting', 'stopped words'])
    )
    if (!adopt) {
      db().exec(`CREATE TEMP TRIGGER b2_perf_fail_import BEFORE DELETE ON queued_messages
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    }
    const journal = journalFor(SESSION)
    await journal.open()
    expect(legacyIds()).toHaveLength(adopt ? 0 : corrections)
    const display = journal.queuedMessages.displayState()
    const feed = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    let visits = 0
    let keyVisits = 0
    function counted<T>(iterator: MapIterator<T>, correction = false): MapIterator<T> {
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const result = next(...args)
        if (!result.done) {
          if (correction) {
            keyVisits++
          } else {
            visits++
          }
        }
        return result
      }
      return iterator
    }
    const values = Map.prototype.values
    const entries = Map.prototype[Symbol.iterator]
    const valuesRead = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return counted(values.call(this))
    })
    const entriesRead = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return counted(entries.call(this))
    })
    const setIterator = Set.prototype[Symbol.iterator]
    const sets = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function (
      this: Set<unknown>
    ) {
      return this.has('u-0') ? counted(setIterator.call(this), true) : setIterator.call(this)
    })
    const gets = vi.spyOn(Map.prototype, 'get')
    const sourceGets = () =>
      gets.mock.contexts.filter((m) => m === display.items || m === display.submissions)
    const sorts = vi.spyOn(Array.prototype, 'sort')
    const json = vi.spyOn(JSON, 'stringify')
    const work = () => [
      keyVisits,
      sorts.mock.contexts.filter((v) => Array.isArray(v) && v[0] === 'u-0').length,
      json.mock.calls.filter(
        ([v]) => Array.isArray(v) && Array.isArray(v[1]) && v[1][0]?.[0] === 'u-0'
      ).length
    ]
    const reset = () => {
      keyVisits = 0
      gets.mockClear()
      sorts.mockClear()
      json.mockClear()
    }
    try {
      for (const id of ['perf-a', 'perf-b', 'old']) {
        feed.open({
          sessionId: SESSION,
          journal,
          fence: 0,
          id,
          boundedFrames: id === 'perf-b',
          cursor: journal.cursor(),
          snapshotCatchUp: id !== 'old',
          readsCurrentRequests: id !== 'old',
          emit: (event) => events.push(event)
        })
      }
      expect(work()).toEqual([corrections, 1, 1])
      expect(sourceGets()).toHaveLength(2 * corrections)
      expect(visits).toBeGreaterThanOrEqual(size)
      const key = journal.publicRead().normalizationKey
      reset()
      visits = 0
      for (let publication = 0; publication < 5; publication++) {
        feed.publish(SESSION, journal)
      }
      // Only subscriber visits; history copies/materialization would add N visits.
      expect(visits).toBe(15)
      expect(work()).toEqual([0, 0, 0])
      expect(sourceGets()).toHaveLength(0)
      const cursor = journal.cursor()
      const snapshot = journal.snapshot()
      await journal.open()
      expect(journal.cursor()).toEqual(cursor)
      expect(journal.queuedMessages.displayState() === display).toBe(false)
      expect(journal.snapshot()).not.toBe(snapshot)
      feed.publish(SESSION, journal)
      expect(work()).toEqual([corrections, 1, 1])
      reset()
      await journal.appendItem(
        { provider: 'codex', threadId: 'progress', turnId: 't', ordinal: 0 },
        message('progress'),
        { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      expect(journal.snapshot().items.at(-1)?.body).toEqual(message('progress'))
      expect(work()).toEqual([0, 0, 0])
      reset()
      feed.publish(SESSION, journal)
      const latest = events.at(-1)
      expect(latest?.type === 'batch' && latest.batch.items.at(-1)?.body).toEqual(
        message('progress')
      )
      expect(work()).toEqual([corrections, 1, 1])
      expect(journal.publicRead().normalizationKey).toBe(key)
    } finally {
      for (const spy of [sets, gets, sorts, json, entriesRead, valuesRead]) {
        spy.mockRestore()
      }
      if (!adopt) {
        db().exec('DROP TRIGGER b2_perf_fail_import')
      }
    }
    expect(events.filter((event) => event.type === 'snapshot')).toHaveLength(2)
    await journal.close()
  }
)

it.each([100, 1_000])('raw selection reuse: %i waiting cards', async (size) => {
  const journal = journalFor(SESSION)
  const rows = Array.from({ length: size }, (_, i): Legacy => [`waiting-${i}`, 'waiting', 'words'])
  seedLegacy(SESSION, rows)
  db().exec(`CREATE TEMP TRIGGER b2_raw_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  await journal.open()
  expect(legacyIds()).toHaveLength(size)
  const feed = new AgentSessionSubscribers()
  const base = { sessionId: SESSION, journal, fence: 0, cursor: journal.cursor() }
  const received: AgentSessionSubscribeEvent[][] = [[], [], []]
  received.forEach((events, index) =>
    feed.open({
      ...base,
      id: String(index),
      boundedFrames: index === 1,
      snapshotCatchUp: index !== 2,
      readsCurrentRequests: index !== 2,
      emit: (event) => events.push(event)
    })
  )
  let visits = 0
  const flatMap = Array.prototype.flatMap
  const scans = vi.spyOn(Array.prototype, 'flatMap')
  scans.mockImplementation(function (this: { messageId?: string }[], callback, thisArg) {
    const legacy = this.length === size && this[0]?.messageId === 'waiting-0'
    return flatMap.call(this, (...args) => {
      visits += legacy ? 1 : 0
      return callback.apply(thisArg, args)
    })
  })
  try {
    const turn = { provider: 'codex' as const, threadId: 'progress', turnId: 't', ordinal: 0 }
    await journal.appendItem(turn, message('progress'), threadWrite)
    feed.publish(SESSION, journal)
    // Canonical history reads do not materialize legacy waiting cards.
    expect(visits).toBe(0)
    expect(journal.publicRead().normalizationKey).toBe('')
    expect(journal.queuedMessages.list().filter((c) => c.state === 'waiting')).toHaveLength(size)
    expect(visits).toBe(size)
    for (const events of received) {
      const items = events.flatMap((e) => (e.type === 'batch' ? e.batch.items : []))
      expect(items.map((i) => i.body)).toContainEqual(message('progress'))
      expect(events.filter((e) => e.type === 'snapshot')).toHaveLength(0)
    }
    visits = 0
    for (let p = 0; p < 5; p++) {
      feed.publish(SESSION, journal)
    }
    expect(visits).toBe(0)
    const answered = { turn: { ...turn, ordinal: -1 }, via: 'steer' as const }
    await handOff(journal, 'u', 'waiting-0', 'words', 'cancelled', 0, undefined, answered, true)
    feed.publish(SESSION, journal)
    const view = journal.publicRead()
    expect(view.normalizationKey).not.toBe('')
    expect(view.snapshot.submissions.find((s) => s.clientMessageId === 'u')).toMatchObject({
      dispatchState: 'unknown',
      queuedMessageId: 'waiting-0'
    })
    const item = view.snapshot.items.find((i) => i.itemId === agentJournalSubmissionKey('u'))
    expect(item?.body).toEqual(message('words'))
    expect(item?.sequence).toBeLessThan(journal.cursor().sequence)
    expect(journal.submissionBody('u')).toEqual(message('words'))
    expect(journal.submission('u')).toMatchObject({ dispatchState: 'unknown' })
    expect(journal.submission('u')?.submittedSequence).toBeLessThan(journal.cursor().sequence)
    expect(
      db()
        .prepare(`SELECT COUNT(*) AS count FROM journal_rows WHERE session_id = ?
        AND json_extract(row_json, '$.kind') = 'dispatch'
        AND json_extract(row_json, '$.clientMessageId') = 'u'
        AND json_extract(row_json, '$.state') = 'rejected'`)
        .get(SESSION)
    ).toMatchObject({ count: 1 })
    // Family eligibility and presentation do not rewrite the original durable observation.
    expect(journal.receiptFor('u')).toBeNull()
    expect(journal.queuedMessages.get('waiting-0')).toMatchObject({
      state: 'dispatched',
      consumedAs: 'u'
    })
    expect(visits).toBeLessThanOrEqual(2 * size)
    visits = 0
    for (let p = 0; p < 5; p++) {
      feed.publish(SESSION, journal)
    }
    expect(visits).toBe(0)
    expect(received.map((es) => es.filter((e) => e.type === 'snapshot').length)).toEqual([1, 1, 0])
  } finally {
    scans.mockRestore()
    db().exec('DROP TRIGGER b2_raw_fail_import')
    await journal.close()
  }
})

it('public metadata follows legacy-only commits, item recreation and epoch replacement', async () => {
  const earlier = journalFor(SESSION)
  await earlier.open()
  await earlier.queuedMessages.insert({ messageId: 'q', body: message('words') })
  await handOff(earlier, 'u', 'q', 'words', 'cancelled')
  await earlier.close()
  seedLegacy(SESSION, [['gone', 'withdrawn', 'deleted']])
  db().exec(`CREATE TEMP TRIGGER b2_source_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const journal = journalFor(SESSION)
  await journal.open()
  const ids = vi.spyOn(journal.queuedMessages.displayState().normalizedHandOffs, Symbol.iterator)
  const key = journal.publicRead().normalizationKey
  const snapshot = journal.snapshot()
  expect(journal.snapshot()).toBe(snapshot)
  expect(key).not.toBe('')
  const cursor = journal.cursor()
  const catchUp = createAgentSessionCatchUpReader(journal, undefined, journal.publicRead())
  const request = { sessionId: SESSION, direction: 'tail' as const }
  const beforeImport = catchUp(request)
  expect(beforeImport).toMatchObject({ ok: true, page: { items: snapshot.items } })
  db().exec('DROP TRIGGER b2_source_fail_import')
  await journal.queuedMessages.importAtOpen()
  expect(journal.cursor()).toEqual(cursor)
  expect(legacyIds()).toEqual([])
  expect(journal.snapshot()).not.toBe(snapshot)
  expect(catchUp(request)).toEqual(beforeImport)
  expect(ids).toHaveBeenCalledTimes(1)
  expect(journal.publicRead().normalizationKey).toBe(key)
  expect(ids).toHaveBeenCalledTimes(2)
  ids.mockRestore()
  const identity = { provider: 'orca' as const, clientMessageId: 'u' }
  await journal.appendTombstone(identity, { fence: 0 })
  expect(journal.publicRead().normalizationKey).toBe('')
  expect(journal.snapshot().items).toEqual([])
  await journal.appendItem(identity, message('recreated'), threadWrite)
  expect([key, '']).not.toContain(journal.publicRead().normalizationKey)
  expect(journal.snapshot().items[0]?.body).toEqual(message('recreated'))
  await journal.rollEpoch('handle_forked', 0)
  expect(journal.epoch).not.toBe(cursor.epoch)
  expect(journal.publicRead().normalizationKey).toBe('')
  expect(journal.snapshot().items).toEqual([])
  await journal.close()
})

it('carries saved independent holds through real publication, bounded snapshot/reset/catch-up/live and the shared reducer', async () => {
  const journal = journalFor(SESSION)
  await journal.open()
  try {
    const body = message('immutable full original')
    await journal.appendSubmission({
      clientMessageId: 'original',
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, body),
      fence: 0,
      origin: 'client',
      handoverRecorded: true,
      options: { model: 'default' }
    })
    await journal.resolveDispatch({
      clientMessageId: 'original',
      state: 'pending',
      fence: 0,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    appendTestJournalQueueRow(db(), journal, 'recovery:original', {
      op: 'queued',
      body,
      recovers: 'original',
      position: 0,
      queuedAt: journal.cursor(),
      options: { model: 'default' },
      returned: { reason: 'old stored uncertainty', rejection: { kind: 'unconfirmed' } }
    })
    await journal.queuedMessages.insert({ messageId: 'W', body: message('waiting') })
    const cards = readPublishedQueuedMessages(journal)
    expect(cards).toMatchObject([
      {
        messageId: 'recovery:original',
        state: 'waiting',
        paused: true,
        body: message('immutable full original')
      },
      { messageId: 'W', state: 'waiting' }
    ])
    expect(cards[1]).not.toHaveProperty('independentRecovery')
    expect(readPublishedQueuedMessages(journal)).toBe(cards)
    // A real move keeps the saved card’s source/body and own hold.
    await journal.queuedMessages.move({ messageId: 'recovery:original', afterMessageId: 'W' })
    const adopted = readPublishedQueuedMessages(journal)
    expect(adopted.find((c) => c.messageId === 'recovery:original')).toEqual({
      ...cards[0],
      position: adopted.find((c) => c.messageId === 'recovery:original')!.position
    })
    const publication = {
      queuedMessages: adopted,
      queuePause: { reason: 'stopped' } as const,
      nextQueuedMessageId: null
    }
    const events: AgentSessionSubscribeEvent[] = []
    const feed = new AgentSessionSubscribers({ readQueuePublication: () => publication })
    feed.open({
      id: 'bounded',
      sessionId: SESSION,
      journal,
      fence: 0,
      boundedFrames: true,
      emit: (event) => events.push(event)
    })
    const snapshot = events.find((event) => event.type === 'snapshot')
    if (!snapshot || snapshot.type !== 'snapshot') {
      throw new Error('missing snapshot')
    }
    const hooks = { readQueuePublication: () => publication }
    const subscriber = { sessionId: SESSION, boundedFrames: true }
    const batch: AgentSessionSubscribeEvent = {
      type: 'batch',
      sessionId: SESSION,
      batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
    }
    const withheld = buildSubscriberFrame(hooks, subscriber, batch, true)
    expect(withheld.frames.every((e) => e.type === 'end' || e.queuedMessages === undefined)).toBe(
      true
    )
    const final = buildSubscriberFrame(hooks, subscriber, batch, false)
    const reset: AgentSessionSubscribeEvent = { ...snapshot, type: 'reset', reset: 'epoch_changed' }
    events.push(
      ...withheld.frames,
      ...final.frames,
      ...buildSubscriberFrame(hooks, subscriber, reset, false).frames
    )
    let desktop = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: { ...snapshot.page, queuedMessages: adopted, queuePause: publication.queuePause }
    })
    // Desktop and phone now consume this same production reducer.
    for (const event of events) {
      desktop = reduceStructuredAgentSession(desktop, { type: 'event', event })
    }
    expect(desktop.queuedMessages).toEqual(adopted)
    expect(desktop.queuePause).toEqual(publication.queuePause)
    const projected = projectQueuedMessageCards(desktop.queuedMessages, desktop.submissions, {
      queuePaused: true
    })
    expect(projected.map((c) => c.hold)).toEqual(['queue-paused', 'paused'])
    expect(queuedMessagesQueuePause(projected, desktop.queuePause ?? null)).toEqual(
      publication.queuePause
    )
    await journal.queuedMessages.move({ messageId: 'recovery:original', beforeMessageId: 'W' })
    const heldBody = message('x'.repeat(Math.floor(BOUNDED_FRAME_CONTENT_BUDGET_BYTES / 3)))
    for (const messageId of ['P1', 'P2', 'P3']) {
      await journal.queuedMessages.insert({ messageId, body: heldBody, holdReason: 'send_failed' })
    }
    await journal.queuedMessages.move({ messageId: 'W', afterMessageId: 'P3' })
    const bounded = boundedQueuePublication({
      ...publication,
      queuedMessages: readPublishedQueuedMessages(journal)
    })
    expect(bounded.queuedMessages.map((c) => c.messageId)).toEqual([
      'recovery:original',
      'P1',
      'P2'
    ])
    expect(bounded.queuedMessages[0]).toMatchObject({
      messageId: 'recovery:original',
      state: 'waiting',
      paused: true,
      body
    })
    expect(bounded.queuedMessages.slice(1).map((c) => c.body)).toEqual([heldBody, heldBody])
    expect(
      queuedMessagesQueuePause(
        projectQueuedMessageCards(bounded.queuedMessages, [], {}),
        publication.queuePause
      )
    ).toBeNull()
  } finally {
    await journal.close()
  }
})
