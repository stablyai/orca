import './journal-host-database-test-support'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as entries from '../../worker-threads/worker-thread-entry-path'
import NativeDatabase from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { JournalIndeterminateWriteError, JournalSqlOwner } from './journal-sql-owner'
import type { JournalPersistenceEffect } from './journal-persistence-plan'
import { journalTransferBatches, journalUnitPackets } from './journal-unit-transfer'
import { JournalHostDatabase, JournalCommittedEffectError } from './journal-host-database'
import {
  buildCommandReceiptTransaction,
  CommandReceiptExistsError
} from './command-receipt-transaction'
import { createJournalReducerState } from './journal-reducer'
import {
  publishJournalOutcomeEpochAsync,
  prepareJournalOutcomeWriteAsync
} from './journal-outcome-write'
import { restoreJournalAsync } from './journal-open'
import { encodeJournalState } from './journal-state-codec'
import { JournalOutcomeCompaction } from './journal-outcome-compaction'
import { vacuumJournalPage } from './journal-incremental-vacuum'

let bundleRoot: string
let workerPath: string
let root: string
const owners: JournalSqlOwner[] = []
const hosts: JournalHostDatabase[] = []
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), 'orca-journal-owner-bundle-'))
  workerPath = join(bundleRoot, 'journal-sql-worker-entry.cjs')
  await build({
    entryPoints: [
      resolve('src/main/native-chat/agent-session-journal/journal-sql-worker-entry.ts')
    ],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-owner-'))
  vi.spyOn(entries, 'resolveWorkerThreadEntryPath').mockReturnValue(workerPath)
})
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.close()
  }
  for (const owner of owners.splice(0)) {
    await owner.close()
  }
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function host() {
  const database = await JournalHostDatabase.open(root)
  hosts.push(database)
  return database
}

it('round trips canonical outcomes through the native owner and compacts without changing saved state', async () => {
  const database = await host()
  let live = createJournalReducerState('chat', 'epoch')
  await database.transaction(
    async (plan) => {
      plan.add({
        kind: 'epoch',
        sessionId: 'chat',
        workspaceId: 'workspace',
        epoch: 'epoch',
        expected: null
      })
      return publishJournalOutcomeEpochAsync(plan, 'chat', 'epoch', [
        {
          v: 4,
          kind: 'epoch',
          epoch: 'epoch',
          seq: 1,
          fence: 1,
          ts: 1,
          reason: 'session_created',
          providerHandle: { kind: 'codex', threadId: 'thread' }
        }
      ])
    },
    false,
    (publication) => {
      live = publication.adopt()
    }
  )
  for (let seq = 2; seq <= 8; seq++) {
    await database.transaction(
      (plan) =>
        prepareJournalOutcomeWriteAsync(
          plan,
          live,
          [
            {
              v: 4,
              kind: 'item',
              epoch: 'epoch',
              seq,
              ts: seq,
              fence: 1,
              itemId: 'stream',
              revision: seq,
              body: { kind: 'status', text: `revision ${seq}` }
            }
          ],
          seq
        ),
      false,
      (transition) => {
        live = transition.adopt()
      }
    )
  }
  const expected = encodeJournalState(live)
  const compaction = new JournalOutcomeCompaction()
  let completed = false
  for (let unit = 0; unit < 32; unit++) {
    if (!(await compaction.page(database))) {
      completed = true
      break
    }
  }
  expect(completed).toBe(true)
  const saved = await database.read((read) => restoreJournalAsync(read, 'chat'))
  expect(saved?.damage).toBeNull()
  expect(saved?.newer).toBeNull()
  expect(saved && encodeJournalState(saved.state)).toEqual(expected)
  expect(
    await database.read((read) =>
      read.prepare("SELECT seq FROM journal_outcomes WHERE field = 'items' ORDER BY seq").all()
    )
  ).toEqual([{ seq: 2 }, { seq: 8 }])
  await expect(vacuumJournalPage(database)).resolves.toBeTypeOf('boolean')
})

it('plans a successor after predecessor adoption and retains committed truth through callback failure', async () => {
  const database = await host()
  const prepared = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let published = 0
  const first = database.transaction(
    async (plan) => {
      prepared.resolve()
      await release.promise
      plan.add(rows(1))
      return 1
    },
    false,
    (value) => {
      published = value
    }
  )
  await prepared.promise
  const second = database.transaction(
    (plan) => {
      expect(published).toBe(1)
      plan.add(rows(2))
    },
    false,
    () => {
      published = 2
      throw new Error('observer failed')
    }
  )
  const rejected = expect(second).rejects.toBeInstanceOf(JournalCommittedEffectError)
  release.resolve()
  await first
  await rejected
  expect(published).toBe(2)
  expect(
    await database.read((read) => read.prepare('SELECT seq FROM journal_rows ORDER BY seq').all())
  ).toEqual([{ seq: 1 }, { seq: 2 }])
})

it('does not let exhausted history readers block a foreground write and drains leased snapshots before close', async () => {
  const database = await host()
  const leases = await Promise.all(
    Array.from({ length: 3 }, () => database.snapshot(() => 'before'))
  )
  const waiting = database.snapshot(() => 'after')
  await database.transaction((plan) => {
    plan.add(rows(1))
  })
  await leases[0].close()
  const next = await waiting
  expect(next.view).toBe('after')
  expect(await next.read.prepare('SELECT seq FROM journal_rows').all()).toEqual([{ seq: 1 }])
  let closed = false
  const closing = database.close().then(() => {
    closed = true
  })
  await next.close()
  expect(closed).toBe(false)
  await Promise.all(leases.slice(1).map((lease) => lease.close()))
  await closing
  expect(database.hasClosed).toBe(true)
})

it('round trips batched store families without sharing mutable packet defaults', async () => {
  const database = await host()
  const upsert: [string, string][] = Array.from({ length: 300 }, (_, index) => [
    `record-${index}`,
    JSON.stringify({ index })
  ])
  await database.transaction((plan) => {
    plan.add({
      kind: 'store',
      insertOperationsIfAbsent: false,
      writes: {
        records: { upsert, remove: ['record-0'] },
        operations: { upsert: [], remove: [] },
        retiredClaimKeys: null,
        sessionTabs: null
      }
    })
  })
  expect(
    await database.read((read) =>
      read.prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY rowid').all()
    )
  ).toEqual(upsert.slice(1).map(([session_id, record_json]) => ({ session_id, record_json })))
})

it('exposes only preceding receipt phases and leaves duplicate receipt units wholly rolled back', async () => {
  const database = await host()
  const receipt = {
    operationId: 'send',
    sessionId: 'chat',
    callerKey: 'caller',
    method: 'agentSession.send',
    fingerprint: 'original',
    acceptedAt: 1,
    status: 'accepted' as const,
    result: { kind: 'journal-row' as const, epoch: 'epoch', sequence: 1 }
  }
  await database.transaction(async (plan) => {
    plan.add({
      kind: 'store',
      insertOperationsIfAbsent: false,
      writes: {
        records: { upsert: [['chat', '{}']], remove: [] },
        operations: { upsert: [], remove: [] },
        retiredClaimKeys: null,
        sessionTabs: null
      }
    })
    expect((await plan.receipts({ kind: 'global' }, ['send'])).get('send')).toEqual({
      verdict: 'absent'
    })
    await buildCommandReceiptTransaction({ kind: 'global' }, receipt).write(plan)
    expect((await plan.receipts({ kind: 'global' }, ['send'])).get('send')).toEqual({
      verdict: 'readable',
      receipt
    })
    expect(
      (await plan.receipts({ kind: 'caller', callerKey: 'other' }, ['send'])).get('send')
    ).toEqual({ verdict: 'absent' })
  })
  const adopted = vi.fn()
  await expect(
    database.transaction(
      async (plan) => {
        plan.add(rows(1))
        await buildCommandReceiptTransaction(
          { kind: 'global' },
          { ...receipt, fingerprint: 'conflict' }
        ).write(plan)
      },
      false,
      adopted
    )
  ).rejects.toBeInstanceOf(CommandReceiptExistsError)
  expect(adopted).not.toHaveBeenCalled()
  expect(await database.read((read) => read.prepare('SELECT seq FROM journal_rows').all())).toEqual(
    []
  )
})
afterAll(async () => {
  await rm(bundleRoot, { recursive: true, force: true })
})
function open(filename = join(root, 'journal.db'), reader = false) {
  const owner = new JournalSqlOwner(filename, { reader })
  owners.push(owner)
  return owner
}
function rows(seq: number, json = 'landed'): JournalPersistenceEffect {
  return { kind: 'rows', sessionId: 'chat', rows: [{ epoch: 'epoch', seq, savedAt: seq, json }] }
}
async function unit(owner: JournalSqlOwner, effects: JournalPersistenceEffect[], normal = false) {
  await owner.request({ type: 'discard' })
  for (const packets of journalTransferBatches(journalUnitPackets(effects))) {
    await owner.request({ type: 'upload', packets })
  }
  return owner.request({ type: 'unit', normal, count: effects.length })
}
async function saved(owner: JournalSqlOwner) {
  return owner.connection.prepare('SELECT seq, row_json FROM journal_rows ORDER BY seq').all()
}

it('keeps host timers and independent reads runnable during a native writer wait, then joins actual exit', async () => {
  const filename = join(root, 'journal.db')
  const owner = open(filename)
  await owner.opened()
  await unit(owner, [rows(1)])
  const reader = open(filename, true)
  await reader.opened()
  const fixture = new NativeDatabase(filename)
  fixture.exec('BEGIN IMMEDIATE')
  let ticked = false
  const release = setTimeout(() => {
    ticked = true
    fixture.exec('ROLLBACK')
  }, 100)
  try {
    const writing = unit(owner, [rows(2)])
    expect(await saved(reader)).toEqual([{ seq: 1, row_json: 'landed' }])
    await expect(writing).resolves.toMatchObject({ type: 'committed' })
    expect(ticked).toBe(true)
  } finally {
    clearTimeout(release)
    if (fixture.isTransaction) {
      fixture.exec('ROLLBACK')
    }
    fixture.close()
  }
  await unit(
    owner,
    Array.from({ length: 130 }, (_, i) => rows(i + 3, 'x'.repeat(3000)))
  )
  const pages = reader.connection.pages('SELECT * FROM journal_rows ORDER BY seq', [])
  const first = await pages.next()
  expect(first.done).toBe(false)
  expect(first.value?.length).toBeGreaterThan(1)
  expect(first.value?.length).toBeLessThan(128)
  await pages.return(undefined)
  const post = vi.spyOn(Worker.prototype, 'postMessage')
  await owner.close()
  expect(post.mock.contexts.find((context) => context instanceof Worker)?.threadId).toBe(-1)
  await expect(saved(owner)).rejects.toThrow(/closing|exited/)
})

it('confirms a failed COMMIT rolls back and restores FULL before a valid successor', async () => {
  const filename = join(root, 'journal.db')
  const fixture = openJournalDatabase(filename).db
  fixture.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER defer_failure AFTER INSERT ON journal_rows WHEN NEW.seq = 1
      BEGIN INSERT INTO child VALUES (1); END;`)
  fixture.close()
  const owner = open(filename)
  await owner.opened()
  await expect(unit(owner, [rows(1)], true)).rejects.toThrow('FOREIGN KEY constraint failed')
  expect(await saved(owner)).toEqual([])
  expect(await owner.connection.prepare('PRAGMA synchronous').get()).toMatchObject({
    synchronous: 2
  })
  await expect(unit(owner, [rows(2)])).resolves.toMatchObject({ type: 'committed' })
  expect(await saved(owner)).toEqual([{ seq: 2, row_json: 'landed' }])
})

it('retains known COMMIT after a FULL-restoration fault and proves FULL before another accepted unit', async () => {
  const injected = join(root, 'postcommit-worker.cjs')
  await writeFile(
    injected,
    `
    const { DatabaseSync } = require('node:sqlite');
    const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
    let normal = false, committed = false;
    DatabaseSync.prototype.exec = function(sql) {
      const value = exec.call(this, sql);
      if (sql === 'COMMIT' && normal) committed = true;
      return value;
    };
    DatabaseSync.prototype.prepare = function(sql) {
      if (sql === 'PRAGMA synchronous = FULL' && committed) {
        committed = false;
        throw new Error('injected postcommit FULL failure');
      }
      const value = prepare.call(this, sql);
      if (sql === 'PRAGMA synchronous = NORMAL') normal = true;
      if (sql === 'PRAGMA synchronous = FULL') normal = false;
      return value;
    };
    require(${JSON.stringify(workerPath)});
  `
  )
  vi.mocked(entries.resolveWorkerThreadEntryPath).mockReturnValue(injected)
  const owner = open()
  await owner.opened()
  expect(await unit(owner, [rows(1)], true)).toMatchObject({
    type: 'committed',
    postcommit: { message: 'injected postcommit FULL failure' }
  })
  expect(await saved(owner)).toEqual([{ seq: 1, row_json: 'landed' }])
  expect(await owner.connection.prepare('PRAGMA synchronous').get()).toMatchObject({
    synchronous: 1
  })
  expect(await unit(owner, [rows(2)])).toMatchObject({ type: 'committed' })
  expect(await owner.connection.prepare('PRAGMA synchronous').get()).toMatchObject({
    synchronous: 2
  })
})

it('settles a lost write acknowledgement once as unknown without replay and observes exit', async () => {
  const filename = join(root, 'journal.db')
  const injected = join(root, 'lost-ack-worker.cjs')
  await writeFile(
    injected,
    `
    const { parentPort } = require('node:worker_threads');
    const post = parentPort.postMessage.bind(parentPort);
    parentPort.postMessage = function(value) {
      if (value.type === 'committed') process.exit(0);
      post(value);
    };
    require(${JSON.stringify(workerPath)});
  `
  )
  vi.mocked(entries.resolveWorkerThreadEntryPath).mockReturnValue(injected)
  const owner = open(filename)
  const fault = vi.fn()
  owner.onFault = fault
  await owner.opened()
  await expect(unit(owner, [rows(1)])).rejects.toBeInstanceOf(JournalIndeterminateWriteError)
  expect(fault).toHaveBeenCalledTimes(1)
  await owner.close()
  vi.mocked(entries.resolveWorkerThreadEntryPath).mockReturnValue(workerPath)
  const reopened = open(filename)
  await reopened.opened()
  expect(await saved(reopened)).toEqual([{ seq: 1, row_json: 'landed' }])
  await expect(unit(reopened, [rows(2)])).resolves.toMatchObject({ type: 'committed' })
})

it('preserves data on failed native open with no synchronous fallback and joins exit', async () => {
  const owner = open(root)
  await expect(owner.opened()).rejects.toThrow()
  await expect(saved(owner)).rejects.toThrow()
  await owner.close()
  await expect(owner.close()).resolves.toBeUndefined()
})
