import { z } from 'zod'
import { expect, vi } from 'vitest'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { OrchestrationStructuredMailboxPointerDelivery } from '../runtime/orchestration/structured-mailbox-pointer-delivery'
import type { OrchestrationMessageWaiter } from '../runtime/orchestration/mailbox-pointer-eligibility'
import { observeMailSqlWork } from '../runtime/orchestration/mail-sql-work.test-support'
import { type openAttachedHostRig, message } from './acp-structured-host.test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'

export function prepareMailPerformanceHistory(
  db: OrchestrationDb,
  mailbox: string,
  runId: string,
  population: number
) {
  const insert = () => db.insertMessage({ from: 'worker', to: mailbox, runId, subject: 'retained' })
  const unknown = Array.from({ length: population }, insert)
  const candidates = Array.from({ length: population }, insert)
  const uncertain = Array.from({ length: 2 }, insert)
  const waited = db.insertMessage({
    from: 'worker',
    to: mailbox,
    runId,
    type: 'question',
    subject: 'waiter'
  })
  const parked = [...unknown, ...candidates, ...uncertain]
  db.recordUnknownMailRead(parked)
  const sql = observeMailSqlWork(
    db.db,
    (query) => query.includes('ORDER BY sequence LIMIT ?') && query.includes('json_valid(handoff)'),
    'json_valid(handoff)'
  )
  let saved: unknown[] = []
  return {
    population,
    sql,
    uncertain: uncertain.length,
    waiters: new Set([{ typeFilter: ['question'] }]),
    restoreParkedCandidates: (handoff: string) => {
      const reference = z.record(z.string(), z.unknown()).parse(JSON.parse(handoff))
      const update = db.db.prepare('UPDATE messages SET handoff = ? WHERE id = ?')
      for (const row of [...candidates, ...uncertain]) {
        // Saved operations without their original submission cannot authorize an automatic retry.
        const operation = uncertain.includes(row) ? `crashed-${row.id}` : 'unowned-history'
        update.run(
          JSON.stringify({
            ...reference,
            phase: uncertain.includes(row) ? 'reserved' : 'offered',
            operationId: operation,
            authorizationId: operation,
            clientMessageId: operation
          }),
          row.id
        )
      }
      saved = parked.map((row) => db.getMessageById(row.id)!.handoff)
      sql.reset()
    },
    finish: () => {
      expect(parked.map((row) => db.getMessageById(row.id)!.handoff)).toEqual(saved)
      expect(
        parked.every((row) => {
          const current = db.getMessageById(row.id)!
          return current.read === 0 && current.recovery_used === 0
        })
      ).toBe(true)
      expect(db.getMessageById(waited.id)).toMatchObject({
        handoff: null,
        read: 0,
        recovery_used: 0
      })
      db.markAsRead([...parked, waited].map((row) => row.id))
    }
  }
}

export async function measureMailDeliveryWork(input: {
  f: Awaited<ReturnType<typeof openAttachedHostRig>>
  db: OrchestrationDb
  delivery: OrchestrationStructuredMailboxPointerDelivery<OrchestrationMessageWaiter>
  mailbox: string
  performance: ReturnType<typeof prepareMailPerformanceHistory>
}) {
  const { f, db, delivery, mailbox, performance } = input
  const journal = f.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const maps = z
    .object({ items: z.instanceof(Map), submissions: z.instanceof(Map) })
    .parse(Object.getOwnPropertyDescriptor(journal, 'state')?.value)
  const flights = z
    .instanceof(Set)
    .parse(Object.getOwnPropertyDescriptor(delivery, 'inFlight')?.value)
  const index = journal.mailHandoffs()
  let indexOperations = 0
  let indexScans = 0
  const indexSpies = ['providers', 'queued', 'identities', 'openers'].flatMap((key) => {
    const map = z.instanceof(Map).parse(Object.getOwnPropertyDescriptor(index, key)?.value)
    return [
      vi.spyOn(map, 'get').mockImplementation((key) => {
        indexOperations++
        return Map.prototype.get.call(map, key)
      }),
      vi.spyOn(map, 'set').mockImplementation((key, value) => {
        indexOperations++
        return Map.prototype.set.call(map, key, value)
      }),
      vi.spyOn(map, 'delete').mockImplementation((key) => {
        indexOperations++
        return Map.prototype.delete.call(map, key)
      }),
      ...(['values', 'entries', 'keys', Symbol.iterator] as const).map((method) =>
        vi.spyOn(map, method).mockImplementation(() => {
          indexScans++
          return Map.prototype[method].call(map)
        })
      )
    ]
  })
  const folds = vi.spyOn(index, 'item')
  for (let n = 0; n < performance.population; n++) {
    await journal.appendItem(
      { provider: 'legacy', agent: 'grok', sessionId: SESSION, recordId: `history-${n}` },
      message('historical output'),
      { fence: f.fence(), turnScope: { kind: 'thread' } }
    )
  }
  await f.host.flushStreamedEvents(SESSION)
  await journal.readInOrder(() => undefined)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(folds).toHaveBeenCalledTimes(performance.population)
  let reading = false
  let lookups = 0
  const scans = [0, 0, 0]
  const mapSpies = [maps.items, maps.submissions].flatMap((map, n) => [
    vi.spyOn(map, 'values').mockImplementation(() => {
      if (reading) {
        scans[n]++
      }
      return Map.prototype.values.call(map)
    }),
    vi.spyOn(map, 'get').mockImplementation((key) => {
      if (reading) {
        lookups++
      }
      return Map.prototype.get.call(map, key)
    })
  ])
  const snapshot = journal.snapshot.bind(journal)
  const snapshotSpy = vi.spyOn(journal, 'snapshot').mockImplementation(() => {
    if (reading) {
      scans[2]++
    }
    return snapshot()
  })
  const read = f.host.readMailHandoffEvidenceNow.bind(f.host)
  const evidence = vi.spyOn(f.host, 'readMailHandoffEvidenceNow').mockImplementation((...args) => {
    reading = true
    try {
      return read(...args)
    } finally {
      reading = false
    }
  })
  const sql = performance.sql
  const freshEvaluations = sql.count()
  sql.reset()
  const candidates = vi.spyOn(db, 'getAutomaticMailCandidates')
  const triggers = performance.population / 10
  const passes = performance.uncertain + 1
  const corpus = performance.population * 2 + performance.uncertain + 5
  expect(freshEvaluations).toBeGreaterThanOrEqual(performance.population)
  expect(freshEvaluations).toBeLessThanOrEqual((passes + 2) * corpus)
  for (let trigger = 0; trigger < triggers; trigger++) {
    const calls = candidates.mock.calls.length
    delivery.deliverForHandle(mailbox)
    await vi.waitFor(
      () => {
        expect(candidates.mock.calls.length).toBeGreaterThan(calls)
        expect(flights.has(mailbox)).toBe(false)
      },
      { interval: 1 }
    )
  }
  const rows = candidates.mock.results.reduce(
    (sum, result) => sum + (result.type === 'return' ? result.value.length : 0),
    0
  )
  // Each uncertain original can restart selection once; pages advance sequence within a pass.
  expect(sql.count()).toBeGreaterThanOrEqual(triggers * performance.population)
  expect(sql.count()).toBeLessThanOrEqual(triggers * (passes + 1) * corpus)
  expect(rows).toBeLessThanOrEqual(
    triggers * passes * (performance.population + performance.uncertain + 5) + triggers
  )
  expect(candidates.mock.calls.length).toBeLessThanOrEqual(
    triggers * (passes * Math.ceil((performance.population + performance.uncertain + 5) / 50) + 1)
  )
  expect(evidence.mock.calls.length).toBeLessThanOrEqual(triggers * passes * 5)
  expect(lookups).toBeLessThanOrEqual(triggers * passes * 50)
  expect(scans).toEqual([0, 0, 0])
  expect(indexScans).toBe(0)
  expect(indexOperations).toBeLessThanOrEqual(20 * (performance.population + triggers * passes))
  expect(folds.mock.calls.length).toBeLessThanOrEqual(performance.population + 2)
  sql.verify((query) => [mailbox, 0, ...(query.includes('NOT IN') ? ['question'] : []), 50])
  sql.restore()
  const discovery = observeMailSqlWork(
    db.db,
    (query) =>
      query.includes('SELECT DISTINCT to_handle FROM messages') &&
      query.includes('handoff IS NOT NULL'),
    'handoff IS NOT NULL'
  )
  expect(db.getOpenMailHandoffHandles()).toEqual([mailbox])
  expect(discovery.count()).toBe(corpus + 1)
  discovery.verify(() => [])
  discovery.restore()
  console.info('actual mail-trigger work', {
    population: performance.population,
    triggers,
    uncertainOperations: performance.uncertain,
    freshEvaluations,
    discoveryEvaluations: discovery.count(),
    candidateJsonEvaluations: sql.count(),
    candidateQueries: candidates.mock.calls.length,
    returnedRows: rows,
    evidenceReads: evidence.mock.calls.length,
    lookups,
    indexOperations,
    indexScans,
    itemFolds: folds.mock.calls.length
  })
  for (const spy of [...indexSpies, folds, ...mapSpies, snapshotSpy, candidates, evidence]) {
    spy.mockRestore()
  }
}
