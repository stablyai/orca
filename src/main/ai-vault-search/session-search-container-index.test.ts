import {
  harness,
  clock,
  ownIndexer,
  dbPath,
  openEngine,
  startIndexer,
  finishPendingObservation,
  openCodeListObservations
} from './session-search-opencode-index.test-fixture'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { writeOpenCodeSqliteDatabase } from '../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-fixture'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  SessionSearchOperationError,
  SessionSearchWorkerClient
} from './session-search-worker-client'

it('finishes removing a missing database while its configured path remains', async () => {
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_gone', turns: [{ role: 'user', parts: ['configuredgonehistory'] }] }
  ])
  const subject = await startIndexer()
  expect(openEngine().search({ query: 'configuredgonehistory' }).hits).toHaveLength(1)
  await rm(dbPath())
  await subject.reconcile()
  await finishPendingObservation(subject)
  expect(openEngine().search({ query: 'configuredgonehistory' }).hits).toHaveLength(0)
  expect(subject.status().phase).toBe('current')
})

it.each(['refused', 'lost response'] as const)(
  'continues an owed full admission after its authority is %s',
  async (fault) => {
    writeOpenCodeSqliteDatabase(dbPath(), [
      { id: 'ses_owed', turns: [{ role: 'user', parts: ['admissionowedtext'] }] },
      { id: 'ses_keeper', turns: [{ role: 'user', parts: ['admissionkeepertext'] }] }
    ])
    const errors: unknown[] = []
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: { ...harness.roots, opencodeDbPaths: [dbPath()] },
      historyDays: null,
      clock,
      fullSweepEveryCycles: 1000,
      onError: (error) => errors.push(error)
    })
    ownIndexer(subject)
    await subject.start()
    await finishPendingObservation(subject)
    const changed = new SyncDatabase(dbPath())
    changed.exec("DELETE FROM session WHERE id='ses_owed'")
    changed.close()
    const request = SessionSearchWorkerClient.prototype.request
    let injected = false,
      proofRefused = false
    const handoff = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        if (
          !injected &&
          command.op === 'catalog' &&
          command.command.kind === 'container-retire' &&
          command.command.authority === 'full' &&
          command.command.scope.includes(dbPath())
        ) {
          injected = true
          if (fault === 'lost response') {
            await request.call(this, command)
          }
          throw new SessionSearchOperationError('fixture full authority refused')
        }
        if (
          fault === 'lost response' &&
          injected &&
          !proofRefused &&
          command.op === 'catalog' &&
          command.command.kind === 'container-drain' &&
          command.command.keys
        ) {
          proofRefused = true
          throw new SessionSearchOperationError('fixture membership projection refused')
        }
        return request.call(this, command)
      })
    try {
      await subject.reconcile({ full: true })
      expect(injected).toBe(true)
      expect(errors.some((error) => error instanceof SessionSearchOperationError)).toBe(true)
      expect(openEngine().search({ query: 'admissionowedtext' }).hits).toHaveLength(1)
      await finishPendingObservation(subject)
      expect(proofRefused).toBe(fault === 'lost response')
      expect(openEngine().search({ query: 'admissionowedtext' }).hits).toHaveLength(0)
      expect(openEngine().search({ query: 'admissionkeepertext' }).hits).toHaveLength(1)
      expect(subject.status().phase).toBe('current')
    } finally {
      handoff.mockRestore()
    }
  }
)

it.each([40, 400])(
  'drains the accepted omissions of %s database sessions in one available pass',
  async (population) => {
    writeOpenCodeSqliteDatabase(dbPath(), [
      ...Array.from({ length: population }, (_, index) => ({
        id: `ses_omitted_${index}`,
        turns: [{ role: 'user' as const, parts: ['boundedomissiontext'] }]
      })),
      { id: 'ses_keeper', turns: [{ role: 'user', parts: ['boundedomissionkeeper'] }] }
    ])
    const subject = await startIndexer()
    const changed = new SyncDatabase(dbPath())
    changed.exec("DELETE FROM session WHERE id <> 'ses_keeper'")
    changed.close()
    const traffic = vi.spyOn(SessionSearchWorkerClient.prototype, 'request')
    try {
      await subject.reconcile({ full: true })
      // One source and its accepted removal/retirement pages have fixed dispatch overhead per page.
      const bookkeeping = traffic.mock.calls.filter(
        ([command]) =>
          command.op === 'sync' ||
          command.op === 'catalog' ||
          command.op === 'candidates' ||
          command.op === 'work' ||
          command.op === 'coverage' ||
          command.op === 'file-page'
      )
      expect(bookkeeping.length).toBeLessThanOrEqual(200 + 64 * Math.ceil(population / 256))
    } finally {
      traffic.mockRestore()
    }
    expect(openEngine().search({ query: 'boundedomissiontext' }).hits).toHaveLength(0)
    expect(openEngine().search({ query: 'boundedomissionkeeper' }).hits).toHaveLength(1)
    expect(subject.status().phase).toBe('current')
  }
)

it('indexes every session from a long database path through bounded expanded requests', async () => {
  const physical = join(
    harness.root,
    ...Array.from({ length: 8 }, () => 'a'.repeat(40)),
    'opencode.db'
  )
  const sessions = Array.from({ length: 256 }, (_, index) => ({
    id: String(index).padStart(32, 's'),
    turns: [{ role: 'user' as const, parts: [`longpathsession${String(index).padStart(3, '0')}`] }]
  }))
  writeOpenCodeSqliteDatabase(physical, sessions)
  const traffic = vi.spyOn(SessionSearchWorkerClient.prototype, 'request')
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [physical] },
    historyDays: null,
    clock,
    fullSweepEveryCycles: 1000,
    onError: (error) => {
      throw error
    }
  })
  ownIndexer(subject)
  try {
    await subject.start()
    await finishPendingObservation(subject)
    const search = openEngine()
    for (let index = 0; index < 256; index++) {
      expect(
        search.search({ query: `longpathsession${String(index).padStart(3, '0')}` }).hits[0]
          ?.sessionId
      ).toBe(String(index).padStart(32, 's'))
    }
    for (const [command] of traffic.mock.calls) {
      if (command.op === 'catalog' && command.command.kind === 'container-apply') {
        expect(command.command.rows.length).toBeLessThanOrEqual(256)
        expect(JSON.stringify(command).length * 2 + 1024).toBeLessThanOrEqual(256 * 1024)
      }
    }
    expect(subject.status().phase).toBe('current')
  } finally {
    traffic.mockRestore()
  }
})

it('resumes interrupted omission work fairly without repeating either full observation', async () => {
  const other = join(harness.root, 'second-db', 'opencode.db')
  for (const path of [dbPath(), other]) {
    writeOpenCodeSqliteDatabase(path, [
      ...Array.from({ length: path === other ? 1 : 400 }, (_, index) => ({
        id: `${path === other ? 'second' : 'first'}_${index}`,
        turns: [
          {
            role: 'user' as const,
            parts: [path === other ? 'secondomissiontext' : 'firstomissiontext']
          }
        ]
      })),
      {
        id: path === other ? 'second_keeper' : 'first_keeper',
        turns: [{ role: 'user', parts: ['fairkeepertext'] }]
      }
    ])
  }
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [dbPath(), other] },
    historyDays: null,
    clock,
    discoveryDeadlineMs: 1000,
    fullSweepEveryCycles: 1000,
    onError: (error) => {
      throw error
    }
  })
  ownIndexer(subject)
  await subject.start()
  await finishPendingObservation(subject)
  for (const path of [dbPath(), other]) {
    const changed = new SyncDatabase(path)
    changed.exec("DELETE FROM session WHERE id NOT LIKE '%keeper'")
    changed.close()
  }
  let cost = 0
  const now = clock.now.bind(clock)
  const timing = vi.spyOn(clock, 'now').mockImplementation(() => now() + cost)
  const request = SessionSearchWorkerClient.prototype.request
  const traffic = vi
    .spyOn(SessionSearchWorkerClient.prototype, 'request')
    .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
      const result = await request.call(this, command)
      if (
        command.op === 'catalog' &&
        command.command.kind === 'container-retire' &&
        command.command.phase
      ) {
        cost += 1000
      }
      return result
    })
  try {
    await subject.reconcile({ full: true })
    expect(openEngine().search({ query: 'firstomissiontext' }).hits.length).toBeGreaterThan(0)
    const engine = openEngine()
    for (
      let turn = 0;
      turn < 100 && engine.search({ query: 'secondomissiontext' }).hits.length;
      turn++
    ) {
      await subject.reconcile()
    }
    expect(engine.search({ query: 'secondomissiontext' }).hits).toHaveLength(0)
    expect(engine.search({ query: 'firstomissiontext' }).hits.length).toBeGreaterThan(0)
    await finishPendingObservation(subject)
    expect(engine.search({ query: 'firstomissiontext' }).hits).toHaveLength(0)
    expect(engine.search({ query: 'fairkeepertext' }).hits).toHaveLength(2)
    for (const path of [dbPath(), other]) {
      expect(
        openCodeListObservations.filter(
          ({ paths, limit }) => limit === Infinity && paths.includes(path)
        )
      ).toHaveLength(2)
    }
    expect(subject.status().phase).toBe('current')
  } finally {
    timing.mockRestore()
    traffic.mockRestore()
  }
})
