import { settleTestSubscriberDeliveries } from './agent-session-subscriber-test-support'
import * as provenance from '../agent-session-journal/journal-input-provenance'
import {
  JournalDraftMap,
  JournalDraftSet
} from '../agent-session-journal/journal-transition-collections'
import { LegacyQueuedCards } from '../agent-session-journal/journal-queue-import'
import * as transitions from '../agent-session-journal/journal-reducer-transition'
import * as outcomes from '../agent-session-journal/journal-outcome-codec'
import { JournalInputCardIndex } from '../agent-session-journal/journal-input-card-index'
import { JournalInputLineageOwner } from '../agent-session-journal/journal-input-lineage'
import { encodeJournalState } from '../agent-session-journal/journal-state-codec'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
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
    const corrections = 1
    const earlier = await journalFor(SESSION)
    await earlier.open()
    await handOff(
      earlier,
      'u-0',
      'q-0',
      'stopped words',
      'cancelled',
      0,
      async () => {
        for (let ordinal = 0; ordinal < size; ordinal++) {
          await earlier.appendItem(
            { provider: 'codex', threadId: 'history', turnId: 't', ordinal },
            { ...message('old answer'), role: 'assistant' },
            { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          )
        }
      },
      { turn: { provider: 'codex', threadId: 'history', turnId: 't', ordinal: -1 }, via: 'steer' }
    )
    await earlier.close()
    await seedLegacy(
      SESSION,
      Array.from({ length: corrections }, (_, i): Legacy => [`q-${i}`, 'waiting', 'stopped words'])
    )
    if (!adopt) {
      ;(await db()).exec(`CREATE TRIGGER b2_perf_fail_import BEFORE DELETE ON queued_messages
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    }
    const journal = await journalFor(SESSION)
    await journal.open()
    expect(await legacyIds()).toHaveLength(adopt ? 0 : corrections)
    let display = journal['state']
    const feed = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    let visits = 0
    let keyVisits = 0
    let currentDisplay = display
    let snapshotReading = false
    let snapshotVisits = 0
    let projecting = false
    let projectionVisits = 0
    let projectionReads = 0
    let recordWrites = 0
    const displayState = LegacyQueuedCards.prototype.displayState
    const displayRead = vi
      .spyOn(LegacyQueuedCards.prototype, 'displayState')
      .mockImplementation(function (this: LegacyQueuedCards) {
        projecting = true
        try {
          return (currentDisplay = displayState.call(this))
        } finally {
          projecting = false
        }
      })
    function counted<T>(iterator: MapIterator<T>, correction = false): MapIterator<T> {
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const result = next(...args)
        if (!result.done) {
          if (projecting) {
            projectionVisits++
          }
          if (snapshotReading) {
            snapshotVisits++
          }
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
      return this === journal['state'].normalizedHandOffs
        ? counted(setIterator.call(this), true)
        : projectionIterator(setIterator.call(this))
    })
    function projectionIterator<T>(iterator: MapIterator<T>): MapIterator<T> {
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const result = next(...args)
        if (!result.done) {
          if (projecting) {
            projectionVisits++
          }
          if (snapshotReading) {
            snapshotVisits++
          }
        }
        return result
      }
      return iterator
    }
    const mapKeys = Map.prototype.keys
    const mapEntries = Map.prototype.entries
    const overlayKeys = JournalDraftMap.prototype.keys
    const setKeys = Set.prototype.keys
    const setValues = Set.prototype.values
    const setEntries = Set.prototype.entries
    const overlayValues = JournalDraftSet.prototype.values
    const collectionSpies = [
      vi.spyOn(Map.prototype, 'keys').mockImplementation(function (this: Map<unknown, unknown>) {
        return projectionIterator(mapKeys.call(this))
      }),
      vi.spyOn(Map.prototype, 'entries').mockImplementation(function (this: Map<unknown, unknown>) {
        return projectionIterator(mapEntries.call(this))
      }),
      vi.spyOn(JournalDraftMap.prototype, 'keys').mockImplementation(function (
        this: JournalDraftMap<unknown, unknown>
      ) {
        return projectionIterator(overlayKeys.call(this))
      }),
      vi.spyOn(Set.prototype, 'keys').mockImplementation(function (this: Set<unknown>) {
        return projectionIterator(setKeys.call(this))
      }),
      vi.spyOn(Set.prototype, 'values').mockImplementation(function (this: Set<unknown>) {
        return projectionIterator(setValues.call(this))
      }),
      vi.spyOn(Set.prototype, 'entries').mockImplementation(function (this: Set<unknown>) {
        return projectionIterator(setEntries.call(this))
      }),
      vi.spyOn(JournalDraftSet.prototype, 'values').mockImplementation(function (
        this: JournalDraftSet<unknown>
      ) {
        return projectionIterator(overlayValues.call(this))
      })
    ]
    const mapGet = Map.prototype.get
    const gets = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
      this: Map<unknown, unknown>,
      key
    ) {
      if (projecting) {
        projectionReads++
      }
      return mapGet.call(this, key)
    })
    const overlayGet = JournalDraftMap.prototype.get
    const draftGets = vi.spyOn(JournalDraftMap.prototype, 'get').mockImplementation(function (
      this: JournalDraftMap<unknown, unknown>,
      key
    ) {
      if (projecting) {
        projectionReads++
      }
      return overlayGet.call(this, key)
    })
    const mapHas = Map.prototype.has
    const sourceHas = vi.spyOn(Map.prototype, 'has').mockImplementation(function (
      this: Map<unknown, unknown>,
      key
    ) {
      const state = journal['state']
      if (
        projecting &&
        (this === state.items || this === state.submissions || this === state.inputs.presentations)
      ) {
        projectionReads++
      }
      return mapHas.call(this, key)
    })
    const setHas = Set.prototype.has
    const sourceSetHas = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<unknown>,
      key
    ) {
      if (projecting && this === journal['state'].normalizedHandOffs) {
        projectionReads++
      }
      return setHas.call(this, key)
    })
    const overlaySet = JournalDraftMap.prototype.set
    const writes = vi.spyOn(JournalDraftMap.prototype, 'set').mockImplementation(function (
      this: JournalDraftMap<unknown, unknown>,
      key,
      value
    ) {
      if (projecting) {
        recordWrites++
      }
      return overlaySet.call(this, key, value)
    })
    const sourceGets = () =>
      [...gets.mock.contexts, ...draftGets.mock.contexts].filter(
        (m) => m === currentDisplay.items || m === currentDisplay.submissions
      )
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
      projectionVisits = projectionReads = recordWrites = 0
      gets.mockClear()
      draftGets.mockClear()
      sorts.mockClear()
      json.mockClear()
    }
    try {
      display = journal.queuedMessages.displayState()
      const coldProjection = { visits: projectionVisits, reads: projectionReads, recordWrites }
      reset()
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
        await settleTestSubscriberDeliveries(feed)
      }
      expect(work()).toEqual([0, 1, 1])
      // Adopted display shares the raw map used by the keyed inverse lookup.
      expect(sourceGets()).toHaveLength((adopt ? 3 : 2) * corrections)
      expect(visits).toBeGreaterThanOrEqual(size)
      const key = journal.publicRead().normalizationKey
      const coldPublication = { visits, corrections: work() }
      reset()
      visits = 0
      for (let publication = 0; publication < 5; publication++) {
        feed.publish(SESSION, journal)
        await settleTestSubscriberDeliveries(feed)
        await settleTestSubscriberDeliveries(feed)
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
      await settleTestSubscriberDeliveries(feed)
      // Count canonical normalization reads, not the draft’s changed-key metadata.
      expect(work()).toEqual([0, 1, 1])
      reset()
      const hotWork: { visits: number; reads: number; recordWrites: number }[] = []
      for (let publication = 0; publication < 10; publication++) {
        const before = journal.cursor()
        const from = events.length
        const body = { ...message(`progress-${publication}`), role: 'assistant' as const }
        reset()
        await journal.appendItem(
          { provider: 'codex', threadId: 'progress', turnId: 't', ordinal: publication },
          body,
          { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        feed.publish(SESSION, journal)
        await settleTestSubscriberDeliveries(feed)
        const delivered = events.slice(from)
        expect(delivered).toHaveLength(3)
        for (const event of delivered) {
          expect(event.type).toBe('batch')
          if (event.type === 'batch') {
            expect(event.batch.cursor.epoch).toBe(before.epoch)
            expect(event.batch.cursor.sequence).toBeGreaterThan(before.sequence)
            expect(event.batch.items.map((item) => item.body)).toEqual([body])
            expect(event.batch.removedItemIds).toEqual([])
          }
        }
        hotWork.push({ visits: projectionVisits, reads: projectionReads, recordWrites })
        expect(projectionVisits).toBe(0)
        expect(projectionReads).toBeLessThanOrEqual(8 * corrections)
        expect(recordWrites).toBe(adopt ? 0 : 3 * corrections)
        expect(work()).toEqual([0, 1, 1])
        expect(journal.publicRead().normalizationKey).toBe(key)
        // Plain point reads prove unchanged presentation without a full snapshot in the hot phase.
        const current = journal.queuedMessages.displayState()
        expect(current.submissions.get('u-0')).toMatchObject({ dispatchState: 'unknown' })
        expect(current.items.get('orca:u-0')?.body).toEqual(message('stopped words'))
        expect(current.items.get('orca:u-0')?.sequence).toBe(
          display.items.get('orca:u-0')?.sequence
        )
      }
      await journal.open()
      reset()
      snapshotVisits = 0
      snapshotReading = true
      expect(journal.snapshot().items).toHaveLength(size + corrections + 10)
      snapshotReading = false
      expect(snapshotVisits).toBeGreaterThanOrEqual(size)
      process.stdout.write(
        `FIXED_RECOVERY_PROJECTION ${JSON.stringify({ size, corrections, adopt, coldProjection, coldPublication, hotWork, requestedSnapshotVisits: snapshotVisits })}\n`
      )
    } finally {
      for (const spy of [
        ...collectionSpies.toReversed(),
        displayRead,
        sourceHas,
        sourceSetHas,
        writes,
        sets,
        gets,
        draftGets,
        sorts,
        json,
        entriesRead,
        valuesRead
      ]) {
        spy.mockRestore()
      }
      if (!adopt) {
        ;(await db()).exec('DROP TRIGGER b2_perf_fail_import')
      }
    }
    expect(events.filter((event) => event.type === 'snapshot')).toHaveLength(2)
    await journal.close()
  }
)

it.each([10, 100])('bounds actual canonical fallback reads/writes N=%i', async (n) => {
  const session = 'overlay-scale'
  const seed = await journalFor(session)
  await seed.open()
  await seed.queuedMessages.insert({ messageId: 'C', body: message('/compact') })
  await seed.close()
  await seedLegacy(
    session,
    Array.from({ length: n }, (_, i): Legacy => [`D${i}`, 'waiting', `body${i}`])
  )
  ;(await db()).exec(`CREATE TRIGGER overlay_scale_import_failure BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'import failure'); END`)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const journal = await journalFor(session)
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
  const index = JournalInputCardIndex.prototype.indexCardSteps
  const indexSpy = vi
    .spyOn(JournalInputCardIndex.prototype, 'indexCardSteps')
    .mockImplementation(function* (this: JournalInputCardIndex, ...args) {
      indexed++
      return yield* index.apply(this, args)
    })
  const introduce = JournalInputCardIndex.prototype.introduceOverlaysSteps
  const introduction = vi
    .spyOn(JournalInputCardIndex.prototype, 'introduceOverlaysSteps')
    .mockImplementation(function* (this: JournalInputCardIndex, change) {
      yield* introduce.call(this, (card) => {
        introduced++
        change(card)
      })
    })
  const frontier = JournalInputLineageOwner.prototype.restoreFrontierSteps
  const frontierSpy = vi
    .spyOn(JournalInputLineageOwner.prototype, 'restoreFrontierSteps')
    .mockImplementation(function* (this: JournalInputLineageOwner, ...args) {
      frontiers++
      return yield* frontier.apply(this, args)
    })
  const isolate = transitions.isolateJournalTransition
  const isolateSpy = vi
    .spyOn(transitions, 'isolateJournalTransition')
    .mockImplementation((...args) => {
      const draft = isolate(...args)
      drafts.push(draft)
      return draft
    })
  const encode = outcomes.encodeJournalOutcomeSteps
  const encodeSpy = vi.spyOn(outcomes, 'encodeJournalOutcomeSteps').mockImplementation(function* (
    ...args
  ) {
    const encoded = yield* encode(...args)
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
      !('kind' in first) &&
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
    measurements.discovery = await measure()
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
    expect(await measure()).toEqual({
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
    measurements.reads = await measure()
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'unrelated' },
      message('unrelated'),
      threadWrite
    )
    measurements.firstWrite = await measure()
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
    measurements.admissions = await measure()
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
    expect((await measure()).nodes).toBeLessThanOrEqual(160 * n * (1 + Math.ceil(Math.log2(n + 2))))
    // Each native entry contains fixed IDs/cursors and one witness, never card bodies/populations.
    expect(bytes).toBeLessThanOrEqual(400 * n)
    reset()
    ;(await db()).exec('DROP TRIGGER overlay_scale_import_failure')
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
    measurements.edit = await measure()
    expect({ indexed, cards, cohortVisits, introduced }).toEqual({
      indexed: 1,
      cards: 0,
      cohortVisits: 0,
      introduced: 0
    })
    reset()
    await journal.queuedMessages.withdraw(Array.from({ length: n }, (_, i) => `D${i}`))
    expect(journal['state'].inputCards.size).toBe(1)
    expect(await legacyIds(session)).toEqual([])
    measurements.retirement = await measure()
    // One bulk adoption, withdrawals, then current-cohort retirement; not n separate flushes.
    expect(cards).toBe(n)
    expect(bytes).toBe(4 * n) // Native tombstone null values.
    expect(indexed).toBeLessThanOrEqual(3 * n)
    expect(cohortVisits).toBeLessThanOrEqual(6 * n)
    console.info('overlay-operation-counts', JSON.stringify({ n, measurements }))
    expect(fixture.rig.dispatch).not.toHaveBeenCalled()
  } finally {
    ;(await db()).exec('DROP TRIGGER IF EXISTS overlay_scale_import_failure')
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
