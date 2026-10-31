import * as provenance from '../agent-session-journal/journal-input-provenance'
import { JournalDraftMap } from '../agent-session-journal/journal-transition-collections'
import * as transitions from '../agent-session-journal/journal-reducer-transition'
import * as outcomes from '../agent-session-journal/journal-outcome-codec'
import { JournalInputCardIndex } from '../agent-session-journal/journal-input-card-index'
import { JournalInputLineageOwner } from '../agent-session-journal/journal-input-lineage'
import { encodeJournalState } from '../agent-session-journal/journal-state-codec'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

import {
  fixture,
  threadWrite,
  type Legacy,
  db,
  handOff,
  journalFor,
  legacyIds,
  message,
  seedLegacy
} from './structured-agent-session-queue-import-contract-test-fixture'

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
      // Import normalizes the one affected submission and refreshes its derived entered index.
      // Each touched map key is listed for encoding and adoption; no other history key is visited.
      expect(work()).toEqual([corrections + (adopt ? 0 : 2 * 2), 1, 1])
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

it.each([10, 100])('bounds actual canonical fallback reads/writes N=%i', async (n) => {
  const session = 'overlay-scale'
  const seed = journalFor(session)
  await seed.open()
  await seed.queuedMessages.insert({ messageId: 'C', body: message('/compact') })
  await seed.close()
  seedLegacy(
    session,
    Array.from({ length: n }, (_, i): Legacy => [`D${i}`, 'waiting', `body${i}`])
  )
  db().exec(`CREATE TEMP TRIGGER overlay_scale_import_failure BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'import failure'); END`)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const journal = journalFor(session)
  let indexed = 0
  let draftKeys = 0
  let receiptQueries = 0
  let cohortVisits = 0
  let introduced = 0
  let frontiers = 0
  let mutations = 0
  let entries = 0
  let cards = 0
  let bytes = 0
  let drafts: ReturnType<typeof transitions.isolateJournalTransition>[] = []
  const index = JournalInputCardIndex.prototype.indexCard
  const indexSpy = vi
    .spyOn(JournalInputCardIndex.prototype, 'indexCard')
    .mockImplementation(function (this: JournalInputCardIndex, ...args) {
      indexed++
      return index.apply(this, args)
    })
  const introduce = JournalInputCardIndex.prototype.introduceOverlays
  const introduction = vi
    .spyOn(JournalInputCardIndex.prototype, 'introduceOverlays')
    .mockImplementation(function (this: JournalInputCardIndex, change) {
      introduce.call(this, (card) => {
        introduced++
        change(card)
      })
    })
  const frontier = JournalInputLineageOwner.prototype.restoreFrontier
  const frontierSpy = vi
    .spyOn(JournalInputLineageOwner.prototype, 'restoreFrontier')
    .mockImplementation(function (this: JournalInputLineageOwner, ...args) {
      frontiers++
      return frontier.apply(this, args)
    })
  const isolate = transitions.isolateJournalTransition
  const isolateSpy = vi
    .spyOn(transitions, 'isolateJournalTransition')
    .mockImplementation((...args) => {
      const draft = isolate(...args)
      drafts.push(draft)
      return draft
    })
  const encode = outcomes.encodeJournalOutcomes
  const encodeSpy = vi.spyOn(outcomes, 'encodeJournalOutcomes').mockImplementation((...args) => {
    const encoded = encode(...args)
    for (const value of encoded.values) {
      if (value.field === 'inputEntries') {
        entries++
      }
      if (value.field === 'inputCards') {
        cards++
      }
      if (value.field === 'inputEntries' || value.field === 'inputCards') {
        bytes += Buffer.byteLength(value.json)
      }
    }
    return encoded
  })
  const map = Array.prototype.map
  const flatMap = Array.prototype.flatMap
  const isCohort = (array: unknown[]) => {
    const first = array[0]
    return (
      typeof first === 'object' &&
      first !== null &&
      'messageId' in first &&
      typeof first.messageId === 'string' &&
      first.messageId.startsWith('D')
    )
  }
  const maps = vi.spyOn(Array.prototype, 'map').mockImplementation(function (
    this: unknown[],
    callback,
    thisArg
  ) {
    const cohort = isCohort(this)
    return map.call(this, (...args) => {
      if (cohort) {
        cohortVisits++
      }
      return callback.apply(thisArg, args)
    })
  })
  const flatMaps = vi.spyOn(Array.prototype, 'flatMap').mockImplementation(function (
    this: unknown[],
    callback,
    thisArg
  ) {
    const cohort = isCohort(this)
    return flatMap.call(this, (...args) => {
      if (cohort) {
        cohortVisits++
      }
      return callback.apply(thisArg, args)
    })
  })
  const keys = JournalDraftMap.prototype.keys
  const keySpy = vi.spyOn(JournalDraftMap.prototype, 'keys').mockImplementation(function* (
    this: JournalDraftMap<unknown, unknown>
  ) {
    for (const key of keys.call(this)) {
      draftKeys++
      yield key
    }
    return undefined
  })
  const acceptance = provenance.journalInputAcceptance
  const receiptSpy = vi
    .spyOn(provenance, 'journalInputAcceptance')
    .mockImplementation((...args) => {
      receiptQueries++
      return acceptance(...args)
    })
  const measurements: Record<string, unknown> = {}
  const measure = () => ({
    indexed,
    draftKeys,
    receiptQueries,
    cohortVisits,
    introduced,
    frontiers,
    mutations,
    entries,
    cards,
    bytes,
    nodes: drafts.reduce((sum, draft) => sum + draft.tracked(), 0),
    derived: drafts.reduce((sum, draft) => sum + draft.trackedDerived(), 0)
  })
  const reset = () => {
    indexed =
      draftKeys =
      receiptQueries =
      cohortVisits =
      introduced =
      frontiers =
      mutations =
      entries =
      cards =
      bytes =
        0
    drafts = []
  }
  try {
    await journal.open()
    measurements.discovery = measure()
    expect(indexed).toBeLessThanOrEqual(5 * n + 1)
    expect(cohortVisits).toBeLessThanOrEqual(8 * n)
    expect(frontiers).toBe(1)
    expect(cards).toBe(2 * n - 1) // Attempted failed import, never adopted.
    expect(introduced).toBe(n) // Failed import prepared this actual cohort, but adopted none.
    expect(journal['state'].inputCards.size).toBe(1)
    reset()
    const set = journal['state'].inputCards.set.bind(journal['state'].inputCards)
    const mutation = vi.spyOn(journal['state'].inputCards, 'set').mockImplementation((...args) => {
      mutations++
      return set(...args)
    })
    const remove = journal['state'].inputCards.delete.bind(journal['state'].inputCards)
    const clear = journal['state'].inputCards.clear.bind(journal['state'].inputCards)
    const deletion = vi
      .spyOn(journal['state'].inputCards, 'delete')
      .mockImplementation((...args) => {
        mutations++
        return remove(...args)
      })
    const clearing = vi.spyOn(journal['state'].inputCards, 'clear').mockImplementation(() => {
      mutations++
      return clear()
    })
    const before = encodeJournalState(journal['state'])
    for (let i = 0; i < n; i++) {
      journal.publicRead()
      expect(journal.queuedMessages.nextInputCard()?.messageId).toBe('C')
    }
    expect(encodeJournalState(journal['state'])).toEqual(before)
    expect(measure()).toEqual({
      indexed: 0,
      draftKeys: 0,
      receiptQueries: 0,
      cohortVisits: 0,
      introduced: 0,
      frontiers: 0,
      mutations: 0,
      entries: 0,
      cards: 0,
      bytes: 0,
      nodes: 0,
      derived: 0
    })
    mutation.mockRestore()
    deletion.mockRestore()
    clearing.mockRestore()
    measurements.reads = measure()
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'unrelated' },
      message('unrelated'),
      threadWrite
    )
    measurements.firstWrite = measure()
    expect(introduced).toBe(n)
    expect(cards).toBe(n)
    expect(indexed).toBe(n)
    expect(cohortVisits).toBe(0)
    expect(journal['state'].inputCards.size).toBe(n + 1)
    reset()
    for (let i = 0; i < n; i++) {
      await journal.appendSubmission({
        clientMessageId: `M${i}`,
        body: message(`M${i}`),
        payloadFingerprint: `M${i}`,
        origin: 'client',
        handoverRecorded: true,
        fence: 0
      })
      expect(journal.inputOrder.forced(`M${i}`)).toBe(true)
      expect(
        journal.inputOrder.precedes(
          journal.queuedMessages.get(`D${n - 1}`)!,
          journal.submission(`M${i}`)!
        )
      ).toBe(true)
    }
    measurements.admissions = measure()
    expect({
      indexed,
      draftKeys,
      receiptQueries,
      cohortVisits,
      introduced,
      frontiers,
      cards,
      entries
    }).toEqual({
      indexed: 0,
      draftKeys: 0,
      receiptQueries: 0,
      cohortVisits: 0,
      introduced: 0,
      frontiers: 0,
      cards: 0,
      entries: n
    })
    // One input's fixed graph plus at most two AVL paths, each with bounded wrapper fields.
    expect(measure().nodes).toBeLessThanOrEqual(160 * n * (1 + Math.ceil(Math.log2(n + 2))))
    // Each native entry contains fixed IDs/cursors and one witness, never card bodies/populations.
    expect(bytes).toBeLessThanOrEqual(400 * n)
    reset()
    db().exec('DROP TRIGGER overlay_scale_import_failure')
    const old = journal.queuedMessages.get('D0')!
    expect(
      await journal.queuedMessages.update({
        messageId: 'D0',
        expectedBodyFingerprint: old.fingerprint,
        text: 'latest D'
      })
    ).toMatchObject({ status: 'updated' })
    expect(journal.queuedMessages.get('D0')?.body).toEqual(message('latest D'))
    expect(journal['state'].inputCards.size).toBe(n + 1)
    measurements.edit = measure()
    expect({ indexed, cards, cohortVisits, introduced }).toEqual({
      indexed: 1,
      cards: 0,
      cohortVisits: 0,
      introduced: 0
    })
    reset()
    await journal.queuedMessages.withdraw(Array.from({ length: n }, (_, i) => `D${i}`))
    expect(journal['state'].inputCards.size).toBe(1)
    expect(legacyIds(session)).toEqual([])
    measurements.retirement = measure()
    // One bulk adoption, withdrawals, then current-cohort retirement; not n separate flushes.
    expect(cards).toBe(n)
    expect(bytes).toBe(4 * n) // Native tombstone null values.
    expect(indexed).toBeLessThanOrEqual(3 * n)
    expect(cohortVisits).toBeLessThanOrEqual(6 * n)
    console.info('overlay-operation-counts', JSON.stringify({ n, measurements }))
    expect(fixture.rig.dispatch).not.toHaveBeenCalled()
  } finally {
    db().exec('DROP TRIGGER IF EXISTS overlay_scale_import_failure')
    for (const spy of [
      indexSpy,
      introduction,
      frontierSpy,
      isolateSpy,
      encodeSpy,
      maps,
      flatMaps,
      keySpy,
      receiptSpy,
      warn
    ]) {
      spy.mockRestore()
    }
    await journal.close()
  }
})
