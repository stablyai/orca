import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

import {
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
      // A reopen that retries the failed import writes one card; its outcome write lists that card
      // once in the card map and once in the order set: a constant 2, whatever the history size.
      expect(work()).toEqual([corrections + (adopt ? 0 : 2), 1, 1])
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
