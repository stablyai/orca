import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction,
  type JournalTransaction
} from './journal-database'
import { JournalMaintenance } from './journal-maintenance'
import { replayJournal } from './journal-open'
import { JournalPrunePass } from './journal-prune-pass'
import {
  collectJournalPruneGarbage,
  journalPruneEpochLookup,
  JournalPruneState
} from './journal-prune-state'
import type { SqliteStatement } from '../../sqlite/sqlite-statement'
import { renderJournalState } from './journal-reducer'
import { insertJournalRow, publishJournalSessionEpoch } from './journal-row-table'

let root: string
let db: Database.Database
const transaction: JournalTransaction = (run, mode) =>
  runJournalTransaction(db, run, undefined, mode)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-prune-progress-'))
  db = openJournalDatabase(join(root, 'journal.db')).db
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  db.close()
  await rm(root, { recursive: true, force: true })
})

function start(sessionId = 'chat', epoch = 'epoch'): void {
  publishJournalSessionEpoch(db, { sessionId, workspaceId: 'folder' }, epoch)
  insertJournalRow(db, sessionId, {
    v: 1,
    epoch,
    seq: 1,
    fence: 1,
    ts: 1,
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread' }
  })
}

function item(
  seq: number,
  itemId: string,
  revision: number,
  sessionId = 'chat',
  epoch = 'epoch',
  repeats = 10
): void {
  insertJournalRow(db, sessionId, {
    v: 1,
    epoch,
    seq,
    fence: 1,
    ts: seq,
    kind: 'item',
    itemId,
    revision,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: repeats === 0 ? [] : [{ type: 'text', text: `revision ${revision} `.repeat(repeats) }]
    }
  })
}

function drain(sessionId = 'chat', epoch = 'epoch'): { scanned: number; compacted: number } {
  const pass = new JournalPrunePass(db, sessionId, epoch)
  let scanned = 0
  let compacted = 0
  for (let step = 0; step < 20_000; step++) {
    const result = pass.step(db, transaction)
    expect(result.scanned).toBeLessThanOrEqual(32)
    scanned += result.scanned
    compacted += result.compacted
    if (result.done) {
      return { scanned, compacted }
    }
  }
  throw new Error('journal pruning did not finish')
}

function snapshot(sessionId = 'chat') {
  return renderJournalState(replayJournal(db, sessionId)!.state)
}

function bodyAt(seq: number, sessionId = 'chat'): unknown {
  const json = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? AND seq = ?')
    .get(sessionId, seq)?.row_json
  const row: unknown = JSON.parse(String(json))
  return typeof row === 'object' && row !== null && 'body' in row ? row.body : undefined
}

it('continues only the appended suffix across lifecycle and tombstone boundaries', () => {
  transaction(() => {
    start()
    for (let ordinal = 1; ordinal <= 300; ordinal++) {
      item(ordinal + 1, `earlier-${ordinal}`, 1)
    }
    for (let revision = 1; revision <= 3; revision++) {
      item(301 + revision, 'old', revision)
    }
  })
  expect(drain()).toEqual({ scanned: 304, compacted: 1 })
  transaction(() => {
    item(305, 'old', 4)
    insertJournalRow(db, 'chat', {
      v: 1,
      epoch: 'epoch',
      seq: 306,
      fence: 1,
      ts: 306,
      kind: 'lifecycle-batch',
      settlementId: 'boundary',
      mutations: [
        {
          kind: 'item',
          itemId: 'old',
          revision: 5,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'boundary' }] }
        }
      ]
    })
    for (let revision = 6; revision <= 8; revision++) {
      item(301 + revision, 'old', revision)
    }
    for (let revision = 1; revision <= 3; revision++) {
      item(309 + revision, 'new', revision)
    }
    insertJournalRow(db, 'chat', {
      v: 1,
      epoch: 'epoch',
      seq: 313,
      fence: 1,
      ts: 313,
      kind: 'tombstone',
      itemId: 'new',
      revision: 4
    })
    for (let revision = 1; revision <= 3; revision++) {
      item(313 + revision, 'new', revision)
    }
  })
  const before = snapshot()
  expect(drain()).toEqual({ scanned: 12, compacted: 4 })
  expect(snapshot()).toEqual(before)
  for (const seq of [302, 305, 307, 309, 310, 312, 314, 316]) {
    expect(bodyAt(seq)).not.toMatchObject({ blocks: [] })
  }
  for (const seq of [303, 304, 308, 311, 315]) {
    expect(bodyAt(seq)).toMatchObject({ blocks: [] })
  }
  expect(drain()).toEqual({ scanned: 0, compacted: 0 })
})

it('runs finite first and later passes during streaming, then sleeps without changing replay', async () => {
  transaction(() => {
    for (const session of ['a-active', 'b-quiet']) {
      start(session)
      for (let revision = 1; revision <= 3; revision++) {
        item(revision + 1, 'reply', revision, session)
      }
    }
  })
  vi.useFakeTimers()
  const maintenance = new JournalMaintenance(() => db, transaction, 0)
  try {
    await vi.advanceTimersByTimeAsync(0)
    for (let seq = 5; seq <= 24; seq++) {
      transaction(() => item(seq, 'reply', seq - 1, 'a-active', 'epoch', 200))
      maintenance.appended('a-active')
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(bodyAt(3, 'a-active')).not.toMatchObject({ blocks: [] })
    expect(bodyAt(3, 'b-quiet')).toMatchObject({ blocks: [] })
    expect(bodyAt(5, 'a-active')).not.toMatchObject({ blocks: [] })
    expect(db.pragma('freelist_count', { simple: true })).toBe(0)
    for (let seq = 25; seq <= 124; seq++) {
      transaction(() => item(seq, 'reply', seq - 1, 'a-active', 'epoch', 200))
      maintenance.appended('a-active')
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(bodyAt(3, 'a-active')).toMatchObject({ blocks: [] })
    expect(bodyAt(75, 'a-active')).toMatchObject({ blocks: [] })
    const pagesBefore = Number(db.pragma('page_count', { simple: true }))
    const before = [snapshot('a-active'), snapshot('b-quiet')]
    const envelopes = () =>
      db
        .prepare(`SELECT session_id, epoch, seq, ts,
json_remove(row_json, '$.body') AS envelope FROM journal_rows ORDER BY session_id, seq`)
        .all()
    const retained = envelopes()
    await vi.runAllTimersAsync()
    expect(bodyAt(5, 'a-active')).toMatchObject({ blocks: [] })
    expect([snapshot('a-active'), snapshot('b-quiet')]).toEqual(before)
    expect(envelopes()).toEqual(retained)
    expect(db.pragma('freelist_count', { simple: true })).toBe(0)
    expect(Number(db.pragma('page_count', { simple: true }))).toBeLessThan(pagesBefore)
    expect(vi.getTimerCount()).toBe(0)
    maintenance.appended('a-active')
    expect(vi.getTimerCount()).toBe(1)
    maintenance.close()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    maintenance.close()
  }
})

it('schedules a replacement epoch even without an append notification', async () => {
  start()
  vi.useFakeTimers()
  const maintenance = new JournalMaintenance(() => db, transaction, 0)
  try {
    await vi.advanceTimersByTimeAsync(20)
    transaction(() => {
      db.prepare("DELETE FROM journal_rows WHERE session_id = 'chat'").run()
      start('chat', 'replacement')
      for (let revision = 1; revision <= 3; revision++) {
        item(revision + 1, 'reply', revision, 'chat', 'replacement')
      }
    })
    await vi.runAllTimersAsync()
    expect(bodyAt(3)).toMatchObject({ blocks: [] })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    maintenance.close()
  }
})

it('refuses an unknown suffix without rewriting it and continues healthy chats and new epochs', async () => {
  transaction(() => {
    start('a-bad')
    start('z-good')
    for (let revision = 1; revision <= 3; revision++) {
      item(revision + 1, 'reply', revision, 'a-bad')
      item(revision + 1, 'reply', revision, 'z-good')
    }
  })
  expect(drain('a-bad').compacted).toBe(1)
  transaction(() => {
    for (let seq = 5; seq <= 70; seq++) {
      item(seq, 'reply', seq - 1, 'a-bad')
    }
    db.prepare(`UPDATE journal_rows SET row_json = json_set(row_json, '$.v', 999)
WHERE session_id = 'a-bad' AND seq = 70`).run()
  })
  const unchanged = db
    .prepare("SELECT row_json FROM journal_rows WHERE session_id = 'a-bad' ORDER BY seq")
    .all()
  vi.useFakeTimers()
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const maintenance = new JournalMaintenance(() => db, transaction)
  try {
    await vi.runAllTimersAsync()
    expect(
      db.prepare("SELECT row_json FROM journal_rows WHERE session_id = 'a-bad' ORDER BY seq").all()
    ).toEqual(unchanged)
    expect(bodyAt(3, 'z-good')).toMatchObject({ blocks: [] })
    expect(warned).toHaveBeenCalledTimes(1)
    maintenance.appended('a-bad')
    await vi.runAllTimersAsync()
    expect(warned).toHaveBeenCalledTimes(1)
    transaction(() => {
      db.prepare("DELETE FROM journal_rows WHERE session_id = 'a-bad'").run()
      start('a-bad', 'replacement')
      for (let revision = 1; revision <= 3; revision++) {
        item(revision + 1, 'reply', revision, 'a-bad', 'replacement')
      }
    })
    maintenance.appended('a-bad')
    await vi.runAllTimersAsync()
    expect(bodyAt(3, 'a-bad')).toMatchObject({ blocks: [] })
    expect(
      db.prepare("SELECT epoch FROM journal_prune_progress_v1 WHERE session_id = 'a-bad'").all()
    ).toEqual([{ epoch: 'replacement' }])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    maintenance.close()
  }
})

it('resumes from the saved frontier after a reopen, including payloads still owed', async () => {
  const priorIdentities = 16_384
  const tip = priorIdentities + 4
  transaction(() => {
    start()
    for (let ordinal = 1; ordinal <= priorIdentities; ordinal++) {
      item(ordinal + 1, `earlier-${ordinal}`, 1)
    }
    for (let revision = 1; revision <= 3; revision++) {
      item(priorIdentities + 1 + revision, 'reply', revision)
    }
  })
  let pass = new JournalPrunePass(db, 'chat', 'epoch')
  const original = snapshot()
  let scanned = pass.step(db, transaction).scanned
  const candidates = db.prepare('SELECT * FROM temp.journal_prune_items').all()
  const rollback: JournalTransaction = (run, mode) =>
    transaction((connection) => {
      run(connection)
      throw new Error('scan rollback')
    }, mode)
  expect(() => pass.step(db, rollback)).toThrow('scan rollback')
  expect(db.prepare('SELECT * FROM temp.journal_prune_items').all()).toEqual(candidates)
  expect(new JournalPruneState(db, 'chat', 'epoch').progress().scanned).toBe(0)
  while (scanned < 5000) {
    scanned += pass.step(db, transaction).scanned
  }
  const saved = new JournalPruneState(db, 'chat', 'epoch').progress().scanned
  expect(saved).toBeGreaterThanOrEqual(4096)
  expect(scanned - saved).toBeLessThanOrEqual(4127)
  db.close()
  db = openJournalDatabase(join(root, 'journal.db')).db
  pass = new JournalPrunePass(db, 'chat', 'epoch')
  scanned = saved
  while (scanned < tip) {
    scanned += pass.step(db, transaction).scanned
  }
  db.close()
  db = openJournalDatabase(join(root, 'journal.db')).db
  expect(drain()).toEqual({ scanned: 0, compacted: 1 })
  expect(bodyAt(tip - 1)).toMatchObject({ blocks: [] })
  expect(snapshot()).toEqual(original)
  expect(db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS tip FROM journal_rows').get()).toEqual({
    n: tip,
    tip
  })
  expect(journalPruneEpochLookup(db)('chat')).toBeNull()
  transaction(() => {
    for (let revision = 4; revision <= 7; revision++) {
      item(priorIdentities + 1 + revision, 'reply', revision)
    }
  })
  expect(drain()).toEqual({ scanned: 4, compacted: 2 })
  expect(bodyAt(tip)).not.toMatchObject({ blocks: [] })
  expect(bodyAt(tip + 1)).not.toMatchObject({ blocks: [] })
  transaction(() => {
    for (let seq = tip + 5; seq <= tip + 1028; seq++) {
      item(seq, 'empty', seq, 'chat', 'epoch', 0)
    }
  })
  const pending = new JournalPrunePass(db, 'chat', 'epoch')
  let emptyScanned = 0
  while (emptyScanned < 1024) {
    emptyScanned += pending.step(db, transaction).scanned
  }
  db.pragma('incremental_vacuum')
  expect(db.pragma('freelist_count', { simple: true })).toBe(0)
  const before = snapshot()
  const pagesBefore = Number(db.pragma('page_count', { simple: true }))
  db.close()
  db = openJournalDatabase(join(root, 'journal.db')).db
  vi.useFakeTimers()
  const maintenance = new JournalMaintenance(() => db, transaction, 0)
  try {
    await vi.runAllTimersAsync()
    expect(drain()).toEqual({ scanned: 0, compacted: 0 })
    expect(snapshot()).toEqual(before)
    expect(Number(db.pragma('page_count', { simple: true }))).toBeLessThan(pagesBefore)
    expect(db.pragma('freelist_count', { simple: true })).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    maintenance.close()
  }
})

it('pages healthy keys, resumes ordered garbage and discovers changes beyond finite cursors', async () => {
  const healthy = new JournalPruneState(db, 'z-owed', 'epoch')
  transaction(() => {
    for (let ordinal = 0; ordinal < 70; ordinal++) {
      const sessionId = `a${String(ordinal).padStart(3, '0')}`
      publishJournalSessionEpoch(db, { sessionId, workspaceId: 'folder' }, 'epoch')
      const state = new JournalPruneState(db, sessionId, 'epoch')
      state.initialize()
      if (ordinal % 2 === 0) {
        state.refuse()
      }
    }
    start('z-owed')
    for (let revision = 1; revision <= 3; revision++) {
      item(revision + 1, 'reply', revision, 'z-owed', 'epoch', 20_000)
    }
    for (const sessionId of ['z-owed', 'z-refused', 'z-retired']) {
      const state = new JournalPruneState(db, sessionId, 'epoch')
      state.initialize()
      if (sessionId === 'z-refused') {
        publishJournalSessionEpoch(db, { sessionId, workspaceId: 'folder' }, 'epoch')
        state.refuse()
      }
      for (let ordinal = 0; ordinal < 65; ordinal++) {
        state.set(String(ordinal), {
          seq: ordinal,
          revision: 1,
          signature: '',
          removable: true,
          savedAt: 1,
          observedAt: 1
        })
        if (sessionId !== 'z-owed') {
          state.enqueue(ordinal)
        }
      }
    }
    healthy.advance(4)
    healthy.enqueue(3)
  })
  const legacy = {
    after: { sessionId: 'z-owec', epoch: '' },
    through: { sessionId: 'z-owed', epoch: 'epoch' }
  }
  for (let chunk = 0; chunk < 4; chunk++) {
    collectJournalPruneGarbage(db, transaction, legacy)
  }
  expect(healthy.progress()).toEqual({ scanned: 4, refused: false })
  expect(healthy.next()).toBe(3)
  const pages: { at: number; size: number }[] = []
  const watched = new Set<SqliteStatement>()
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (
      /^SELECT session_id(?:, epoch)? FROM journal_(?:sessions|prune_progress_v1)\nWHERE/.test(
        sql
      ) &&
      !watched.has(statement)
    ) {
      watched.add(statement)
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        const rows = all(...args)
        pages.push({ at: Date.now(), size: rows.length })
        return rows
      })
    }
    return statement
  })
  const pragma = vi.spyOn(db, 'pragma')
  const count = (table: string, sessionId = 'z-refused') =>
    Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId)?.n)
  vi.useFakeTimers()
  let maintenance = new JournalMaintenance(() => db, transaction, 0)
  try {
    await vi.advanceTimersByTimeAsync(60)
    expect(count('temp.journal_prune_items')).toBe(33)
    expect(count('journal_prune_work_v1')).toBe(65)
    expect(count('journal_prune_progress_v1')).toBe(1)
    maintenance.close()
    maintenance = new JournalMaintenance(() => db, transaction, 0)
    await vi.advanceTimersByTimeAsync(10)
    for (const sessionId of ['a000', 'zz-new']) {
      start(sessionId, 'replacement')
      for (let revision = 1; revision <= 3; revision++) {
        item(revision + 1, 'reply', revision, sessionId, 'replacement')
      }
      maintenance.appended(sessionId)
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(bodyAt(3, 'z-owed')).toMatchObject({ blocks: [] })
    expect(bodyAt(3, 'a000')).not.toMatchObject({ blocks: [] })
    expect(bodyAt(3, 'zz-new')).not.toMatchObject({ blocks: [] })
    await vi.runAllTimersAsync()
    expect(bodyAt(3, 'a000')).toMatchObject({ blocks: [] })
    expect(bodyAt(3, 'zz-new')).toMatchObject({ blocks: [] })
    expect(count('temp.journal_prune_items')).toBe(0)
    expect(count('journal_prune_work_v1')).toBe(0)
    expect(count('journal_prune_progress_v1')).toBe(1)
    expect(count('journal_prune_progress_v1', 'z-retired')).toBe(0)
    expect(
      db
        .prepare("SELECT refused FROM journal_prune_progress_v1 WHERE session_id = 'z-refused'")
        .get()?.refused
    ).toBe(1)
    expect(pages.every(({ size }) => size <= 32)).toBe(true)
    expect(pages.filter(({ size }) => size === 32).length).toBeGreaterThan(4)
    expect(new Set(pages.map(({ at }) => at)).size).toBe(pages.length)
    expect(pages.length).toBeLessThan(48)
    expect(
      pragma.mock.calls.filter(([sql]) => sql === 'incremental_vacuum(1)').length
    ).toBeGreaterThan(pages.length)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    maintenance.close()
  }
})
