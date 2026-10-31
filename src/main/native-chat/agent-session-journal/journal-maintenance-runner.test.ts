import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import { restoreJournal } from './journal-open'
import { journalOutcomeSource } from './journal-outcome-format'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
import { JournalOutcomeRebuild } from './journal-outcome-rebuild'
import { JournalProjectionCatchUp } from './journal-projection-catch-up'
import { JOURNAL_LAGGING_CHAT_SQL, JournalMaintenanceRunner } from './journal-state-backfill'
import { ownJournalMaintenance, requestJournalMaintenance } from './journal-maintenance'
import { clearJournalSavedState } from './journal-saved-state'
import { expectProjectionMatches, projectionWriter } from './journal-projection-test-support'

// The production runner over a real database: each test names the guard it exists for.
const epoch = 'epoch-1'
const base = (seq: number, chatEpoch = epoch) => ({
  v: 4,
  epoch: chatEpoch,
  seq,
  ts: 1_000 + seq,
  fence: 1
})
const epochRow = (chatEpoch = epoch): JournalRow => ({
  ...base(1, chatEpoch),
  kind: 'epoch',
  reason: 'session_created',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
})
const item = (seq: number, chatEpoch = epoch): JournalRow => ({
  ...base(seq, chatEpoch),
  kind: 'item',
  itemId: `item-${seq}`,
  revision: 1,
  body: { kind: 'status', text: `item ${seq}` }
})

let root: string
let database: JournalHostDatabase
const runners: JournalMaintenanceRunner[] = []
const rigs: ReturnType<typeof projectionWriter>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-maintenance-runner-'))
  database = openTestJournalHostDatabase(root)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  vi.useRealTimers()
  runners.splice(0).forEach((runner) => runner.stop())
  for (const rig of rigs.splice(0)) {
    rig.projection.close()
    rig.queue.markClosed()
    await rig.queue.drain()
  }
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

/** `between` runs at every rest, which the runner takes between any two pages. */
function runner(between?: (rests: number) => void | Promise<void>, now?: () => number) {
  let rests = 0
  const created = new JournalMaintenanceRunner({
    database: () => database,
    now,
    delay: async () => {
      rests += 1
      await between?.(rests)
    }
  })
  runners.push(created)
  return created
}

/** An outcome-only chat whose disposable cache is gone, so the runner owes it a rebuild. */
function seedLagging(sessionId: string, items: number, chatEpoch = epoch) {
  return database
    .transaction((db) => {
      publishTestJournalEpoch(db, sessionId, chatEpoch)
      const rows = Array.from({ length: items + 1 }, (_, index) =>
        index === 0 ? epochRow(chatEpoch) : item(index + 1, chatEpoch)
      )
      const publication = publishJournalOutcomeEpoch(db, sessionId, chatEpoch, rows)
      clearJournalSavedState(db, sessionId)
      return publication
    })
    .adopt()
}

function cached(sessionId: string, chatEpoch = epoch): boolean {
  const source = journalOutcomeSource(database.db, sessionId, chatEpoch)
  const loaded = restoreJournal(database.db, sessionId)
  return source !== null && loaded?.projectionThrough === source.through
}

const count = (sql: string, ...args: (string | number)[]) =>
  database.db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...args)?.n

function insertRetiredGeneration(db: JournalHostDatabase['db'], keys: number): void {
  const retired = Number(
    db
      .prepare('INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)')
      .run('gone', 'gone-epoch').lastInsertRowid
  )
  const insert = db.prepare(`INSERT INTO journal_outcomes
    (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
    VALUES (?, 1, 'aliases', ?, 1, 's0000000000000001:0000000000000000', ?, 0)`)
  for (let index = 0; index < keys; index++) {
    insert.run(retired, JSON.stringify(`k${index}`), JSON.stringify([`k${index}`, 'v']))
  }
}

// Mutation killed: skipping the two startup sweeps in run().
it('sweeps retired generations and orphaned caches before serving chats', async () => {
  seedLagging('kept', 3)
  await runner().pass()
  expect(cached('kept')).toBe(true)
  database.transaction((db) => {
    insertRetiredGeneration(db, 1)
    db.prepare(`INSERT INTO journal_state (session_id, epoch, generation, through_seq, version,
      state_json) VALUES ('gone', 'gone-epoch', 0, 0, 1, '{}')`).run()
    db.prepare(`INSERT INTO journal_items (session_id, epoch, item_id, ordinal, item_json)
      VALUES ('gone', 'gone-epoch', 'x', 's1', '{}')`).run()
  })
  await runner().pass()
  expect(count('journal_outcome_generations')).toBe(1)
  expect(count('journal_state WHERE session_id = ?', 'gone')).toBe(0)
  expect(count('journal_items WHERE session_id = ?', 'gone')).toBe(0)
  expect(cached('kept')).toBe(true)
})

// Mutations killed: serving chats concurrently (`void this.serve`), and a skipped chat stopping
// the runner (`this.stopped = true` where serve skips a busy chat).
it('rebuilds closed chats one at a time, skipping a busy one while the pass continues', async () => {
  for (const sessionId of ['a', 'b', 'c']) {
    seedLagging(sessionId, 70)
  }
  const busy = ownJournalMaintenance(database.db, 'b', epoch)
  let live = 0
  let most = 0
  const load = JournalProjectionCatchUp.prototype.load
  const close = JournalProjectionCatchUp.prototype.close
  const started = new WeakSet<JournalProjectionCatchUp>()
  vi.spyOn(JournalProjectionCatchUp.prototype, 'load').mockImplementation(function (
    this: JournalProjectionCatchUp,
    pacing
  ) {
    if (!started.has(this)) {
      started.add(this)
      live += 1
      most = Math.max(most, live)
    }
    return load.call(this, pacing)
  })
  vi.spyOn(JournalProjectionCatchUp.prototype, 'close').mockImplementation(function (
    this: JournalProjectionCatchUp
  ) {
    if (started.delete(this)) {
      live -= 1
    }
    close.call(this)
  })
  const maintenance = runner()
  await maintenance.pass()
  await vi.waitFor(() => expect(cached('c')).toBe(true))
  expect(cached('a')).toBe(true)
  expect(cached('b')).toBe(false)
  expect(most).toBe(1)
  busy?.release()
  await maintenance.pass()
  expect(cached('b')).toBe(true)
})

// Mutation killed: the rebuild reading no outcomes past the tip it first saw.
it('rebuilds an open chat that keeps writing, taking each record written between pages', async () => {
  const rig = projectionWriter(database, seedLagging('session-1', 80))
  rigs.push(rig)
  await runner(async (rests) => {
    if (rests === 3 || rests === 6) {
      await rig.writer.enqueue((seq, ts) => ({ ...item(seq), ts }))
    }
  }).pass()
  expect(rig.state().lastSequence).toBe(83)
  expect(cached('session-1')).toBe(true)
  expectProjectionMatches(database, rig.state())
  await rig.writer.enqueue((seq, ts) => ({ ...item(seq), ts }))
  expectProjectionMatches(database, rig.state())
})

// Mutation killed: rest() continuing after stop (`return true` instead of `this.current() !== null`).
it('stops between pages, releasing the chat, and a later runner finishes it', async () => {
  seedLagging('session-1', 80)
  const maintenance = runner((rests) => {
    if (rests === 3) {
      maintenance.stop()
    }
  })
  await maintenance.pass()
  expect(cached('session-1')).toBe(false)
  ownJournalMaintenance(database.db, 'session-1', epoch)?.release()
  await runner().pass()
  expect(cached('session-1')).toBe(true)
})

// Mutation killed: dropping the catch-up's epoch check before each page.
it('abandons a rebuild whose epoch is replaced mid-way, then rebuilds the new epoch', async () => {
  seedLagging('session-1', 80)
  const first = runner((rests) => {
    if (rests === 3) {
      seedLagging('session-1', 1, 'epoch-2')
    }
  })
  await first.pass()
  expect(first.parked.size).toBe(0)
  expect(count('journal_outcome_epochs WHERE epoch = ?', epoch)).toBe(0)
  await runner().pass()
  expect(cached('session-1', 'epoch-2')).toBe(true)
  expect(count('journal_outcome_generations')).toBe(1)
})

// Records are only ever added, so a deterministic failure is a fact of its epoch's records: the
// park is keyed by them, never by the newest sequence. Mutations killed: removing the parked check in
// serve(), and keying the park by the chat's newest sequence, which every write would re-arm.
it('parks a rebuild its records cannot pass while the chat keeps writing, serving other chats, until a new epoch', async () => {
  const rig = projectionWriter(database, seedLagging('session-1', 40))
  rigs.push(rig)
  seedLagging('other', 5)
  database.db
    .prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      SELECT generation, 2, 'aliases', '"k"', 1, 's0000000000000002:0000000000000099', '["k",5]', 0
      FROM journal_outcome_epochs WHERE session_id = 'session-1'`)
    .run()
  const page = vi.spyOn(JournalOutcomeRebuild.prototype, 'page')
  const maintenance = runner()
  await maintenance.pass()
  expect([...maintenance.parked.keys()]).toEqual(['session-1'])
  expect(cached('other')).toBe(true)
  const attempts = () =>
    page.mock.instances.filter(
      (rebuild) => rebuild instanceof JournalOutcomeRebuild && rebuild.sessionId === 'session-1'
    ).length
  expect(attempts()).toBe(1)
  for (let write = 0; write < 5; write++) {
    // Each write finds the cache behind and asks the runner again.
    await rig.writer.enqueue((seq, ts) => ({ ...item(seq), ts }))
    maintenance.request('session-1')
    await maintenance.pass(false)
  }
  await maintenance.pass()
  expect(attempts()).toBe(1)
  seedLagging('session-1', 3, 'epoch-2')
  maintenance.request('session-1')
  await maintenance.pass(false)
  expect(cached('session-1', 'epoch-2')).toBe(true)
})

// Mutation killed: classifying a storage error as content (always parking).
it('backs off a storage failure instead of parking it, and retries once it is due', async () => {
  seedLagging('session-1', 10)
  let clock = 0
  vi.spyOn(JournalOutcomeRebuild.prototype, 'page').mockImplementationOnce(() => {
    throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })
  })
  const maintenance = runner(undefined, () => clock)
  await maintenance.pass()
  expect(maintenance.parked.size).toBe(0)
  await maintenance.pass()
  expect(cached('session-1')).toBe(false)
  clock += 4_000
  await maintenance.pass()
  expect(cached('session-1')).toBe(true)
})

// The requested chat's lookup reads its own row by key; the whole-database list is for the periodic
// pass only. The plan is the same at N and 10N chats.
it('looks a requested chat up by its key, not by scanning chats, at N and 10N', () => {
  const plan = () =>
    database.db
      .prepare(`EXPLAIN QUERY PLAN ${JOURNAL_LAGGING_CHAT_SQL}`)
      .all(1, 'chat-0')
      .map((row) => String(row.detail))
  for (const chats of [10, 100]) {
    database.transaction((db) => {
      for (let index = 0; index < chats; index++) {
        publishTestJournalEpoch(db, `chat-${chats}-${index}`, epoch)
        publishJournalOutcomeEpoch(db, `chat-${chats}-${index}`, epoch, [epochRow()])
      }
    })
    const steps = plan()
    expect(steps.some((step) => /^SEARCH e USING INDEX .*\(session_id=\?\)/.test(step))).toBe(true)
    expect(steps.filter((step) => step.startsWith('SCAN'))).toEqual([])
  }
})

/** The production runner on fake timers: started, woken by requests, never driven by hand. */
function started(): JournalMaintenanceRunner {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const created = new JournalMaintenanceRunner({
    database: () => database,
    delay: async () => {}
  })
  runners.push(created)
  return created.start()
}
const sqliteFailure = () =>
  Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })

// Mutation killed: request() scheduling only when no timer is pending (the periodic one always is).
it('serves a request within its delay after the first pass, not at the next periodic pass', async () => {
  seedLagging('session-1', 10)
  started()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(cached('session-1')).toBe(true)
  database.transaction((db) => clearJournalSavedState(db, 'session-1'))
  expect(cached('session-1')).toBe(false)
  // A write that finds the cache behind asks the database's runner.
  requestJournalMaintenance(database.db, 'session-1')
  await vi.advanceTimersByTimeAsync(999)
  expect(cached('session-1')).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(cached('session-1')).toBe(true)
})

// Mutation killed: the end-of-pass periodic reschedule replacing the sooner retry timer.
it('retries a storage failure in the periodic pass at its backoff, not at the next pass', async () => {
  seedLagging('session-1', 10)
  vi.spyOn(JournalOutcomeRebuild.prototype, 'page').mockImplementationOnce(() => {
    throw sqliteFailure()
  })
  const maintenance = started()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(maintenance.parked.size).toBe(0)
  expect(cached('session-1')).toBe(false)
  await vi.advanceTimersByTimeAsync(3_999)
  expect(cached('session-1')).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(cached('session-1')).toBe(true)
})

// Mutation killed: serve() ending a chat's turn when its load swept a retired page instead.
it('keeps serving a chat whose load first sweeps retired generations', async () => {
  seedLagging('session-1', 10)
  database.transaction((db) => insertRetiredGeneration(db, 100))
  started()
  // A request runs no startup sweep, so the chat's own load meets the retired pages.
  requestJournalMaintenance(database.db, 'session-1')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(
    count(
      'journal_outcomes WHERE generation NOT IN (SELECT generation FROM journal_outcome_epochs)'
    )
  ).toBe(0)
  expect(cached('session-1')).toBe(true)
})
