import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { acquireOrcadInstanceLock } from '../../orcad/instance-lock/orcad-instance-lock'
import { journalDatabasePath, journalDomainDatabasePath } from './database/journal-host-database'
import { readJournalLegacyFailure } from './database/journal-legacy-source'
import { setLegacyJournalRetirementHost } from './journal-legacy-retirement-outcome'
import { JournalLegacyRetirement } from './journal-legacy-retirement'
import { olderOrcaChat } from './journal-legacy-retirement.test-fixture'
import { openJournalWithCommitBarrier } from './journal-retirement-commit.test-fixture'
import { journalSqlReaderPath } from './journal-sql-worker-bundle.test-fixture'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { JournalSqlConversions } from './journal-sql-conversions'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'

const cleanup: (() => void | Promise<void>)[] = []

afterEach(async () => {
  setLegacyJournalRetirementHost(undefined)
  try {
    for (const close of cleanup.splice(0).toReversed()) {
      await close()
    }
  } finally {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  }
})

async function profile(withOriginal: boolean) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.stubEnv('ORCA_APP_VERSION', '1.0.0')
  const root = mkdtempSync(join(tmpdir(), 'orca-retirement-commit-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const lock = acquireOrcadInstanceLock(root, {
    enforcePrivateDataRoot: false,
    startedAtMs: () => 1,
    incarnation: () => null,
    machineIdentity: () => 'retirement-commit-test'
  })
  cleanup.push(() => lock.release())
  const original = journalDatabasePath(root)
  if (withOriginal) {
    olderOrcaChat(original, 'unopened')
  }
  const filename = journalDomainDatabasePath(root)
  const barrier = openJournalWithCommitBarrier(filename, root)
  const { writer } = barrier
  cleanup.push(() => writer.close(), barrier.release)
  expect(await writer.opened()).toBe(false)
  const db = new Database(filename)
  cleanup.push(() => db.close())
  const readers = new JournalSqlReaderPool(filename, original, journalSqlReaderPath())
  cleanup.push(() => readers.close())
  const errors: unknown[] = []
  writer.onFault = (error) => errors.push(error)
  return {
    ...barrier,
    db,
    errors,
    start: (operationKind?: JournalSqlMaintenance['kind']) => {
      let write: ReturnType<JournalSqlOwner['maintain']> | undefined
      const observedWriter: Pick<JournalSqlOwner, 'maintain'> = {
        maintain: (operation, permit) => {
          if (operation.kind !== operationKind || write) {
            return writer.maintain(operation, permit)
          }
          barrier.arm()
          write = writer.maintain(operation, permit)
          return write
        }
      }
      const conversions = new JournalSqlConversions(observedWriter, readers, async () => {})
      const retirement = new JournalLegacyRetirement(
        root,
        observedWriter,
        readers,
        conversions,
        async () => true,
        (error) => errors.push(error),
        undefined,
        undefined,
        undefined,
        { present: () => {}, check: async () => {} },
        '1.0.1'
      )
      cleanup.push(
        () => conversions.close(),
        () => retirement.stop(),
        barrier.release
      )
      return { retirement, conversions, guardedWrite: () => write }
    },
    replaceLock: () => {
      writeFileSync(lock.path, JSON.stringify({ ...lock.record, nonce: 'successor', pid: 45555 }))
      vi.advanceTimersByTime(60_000)
    }
  }
}

it('rolls back a report acknowledgement already applied when the profile lock is lost', async () => {
  const store = await profile(false)
  const marker = () =>
    store.db
      .prepare(`SELECT value FROM agent_session_store_meta
      WHERE key='journal.legacy-retirement-reported.v1'`)
      .get()?.value
  // Control: the same retirement and writer commit while ownership is live.
  let accepting = true
  const report = vi.fn(async () => accepting)
  setLegacyJournalRetirementHost({ report, accepting: () => accepting })
  await store.start().retirement.run()
  expect(marker()).toEqual(expect.stringContaining('absent'))
  store.db.exec(`UPDATE agent_session_store_meta SET value='sentinel'
    WHERE key='journal.legacy-retirement-reported.v1'`)
  const { retirement, guardedWrite } = store.start('legacy-retirement-reported')
  accepting = false
  await retirement.run()
  accepting = true
  const resend = retirement.run()
  try {
    await store.reached()
    store.replaceLock()
  } finally {
    store.release()
  }
  await expect(guardedWrite()).rejects.toMatchObject({
    name: 'JournalRetirementCancelledError',
    outcome: 'rolled-back'
  })
  await resend
  expect(marker()).toBe('sentinel')
  await retirement.run()
  expect(report).toHaveBeenCalledTimes(3)
  expect(store.errors).toEqual([])
  await store.writer.maintain({ kind: 'compaction-complete', now: 1234 })
  await expect(store.writer.maintain({ kind: 'compaction-state' })).resolves.toMatchObject({
    completedAt: 1234
  })
})

it('rolls back a retirement import page and lets a foreground open recover', async () => {
  const store = await profile(true)
  const { retirement, conversions, guardedWrite } = store.start('import-page')
  const items = () =>
    store.db
      .prepare("SELECT count(*) AS count FROM journal_items WHERE session_id='unopened'")
      .get()?.count
  const imported = () =>
    store.db.prepare("SELECT epoch FROM journal_chat_state WHERE session_id='unopened'").get()
      ?.epoch
  const before = items()
  expect(before).toBe(0)
  const walk = retirement.run()
  try {
    await store.reached()
    store.replaceLock()
  } finally {
    store.release()
  }
  await expect(guardedWrite()).rejects.toMatchObject({
    name: 'JournalRetirementCancelledError',
    outcome: 'rolled-back'
  })
  await walk
  expect(items()).toBe(0)
  expect(imported() ?? null).toBeNull()
  expect(readJournalLegacyFailure(store.db, 'unopened')).toBeUndefined()
  expect(store.errors).toEqual([])
  const epoch = await conversions.ensure('unopened')
  expect(epoch).toBe('epoch')
  expect(imported()).toBe('epoch')
  expect(items()).toBeGreaterThan(0)
})

it('defers retirement-state work after failed records installation until ordinary work retries it', async () => {
  const store = await profile(false)
  store.db.exec('ALTER TABLE agent_session_tabs RENAME TO hidden_tabs')
  await expect(store.writer.installRecords()).rejects.toThrow('no such table: agent_session_tabs')
  store.db.exec('ALTER TABLE hidden_tabs RENAME TO agent_session_tabs')
  const { retirement, guardedWrite } = store.start('legacy-retirement-state')
  store.release()
  await retirement.run()
  await expect(guardedWrite()).rejects.toMatchObject({
    name: 'JournalRetirementRecordsPendingError'
  })
  expect(store.writer.recordsPending).toBe(true)
  await store.writer.maintain({ kind: 'compaction-complete', now: 1234 })
  expect(store.writer.recordsPending).toBe(false)
  expect(store.errors).toEqual([])
})
