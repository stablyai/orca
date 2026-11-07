import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './database/journal-database'
import { publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { publishJournalOutcomeEpoch } from './outcomes/journal-outcome-write'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { JournalSqlOwner } from './journal-sql-owner'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { JournalSqlConversions } from './journal-sql-conversions'
import { JournalProjectionStaleError } from './journal-sql-meta'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const roots: string[] = []
const owners: JournalSqlOwner[] = []
const pools: JournalSqlReaderPool[] = []
const converters: JournalSqlConversions[] = []
afterEach(async () => {
  await Promise.all(converters.splice(0).map((converter) => converter.close()))
  await Promise.all(pools.splice(0).map((pool) => pool.close()))
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'journal-conversion-workers-'))
  roots.push(root)
  const filename = join(root, 'journal.db')
  const { db } = openJournalDatabase(filename)
  db.exec('BEGIN IMMEDIATE')
  publishJournalSessionEpoch(db, { sessionId: 'session', workspaceId: 'workspace' }, 'epoch')
  publishJournalOutcomeEpoch(db, 'session', 'epoch', journalSqlLifecycleRows())
  db.exec('COMMIT')
  db.close()
  return { root, filename }
}

async function workers(root: string, filename: string) {
  const writer = new JournalSqlOwner(filename, root, journalSqlWorkerPath())
  owners.push(writer)
  await writer.opened()
  const readers = new JournalSqlReaderPool(filename, journalSqlReaderPath())
  pools.push(readers)
  return { writer, readers }
}

const history = { sessionId: 'session', direction: 'tail' } as const

it('restarts a partly written conversion, preserves the source and accepts the next normal command', async () => {
  const { root, filename } = await fixture()
  const first = await workers(root, filename)
  await first.writer.maintain({ kind: 'conversion-begin', sessionId: 'session' })
  const prepared = await first.readers.prepareConversion('session')
  if (!prepared) {
    throw new Error('expected saved history')
  }
  const page = await prepared.next()
  if (!page) {
    throw new Error('expected conversion rows')
  }
  const { rows, ...table } = page
  await first.writer.maintain({ kind: 'conversion-insert', table, rows })
  await expect(first.readers.read(history)).rejects.toBeInstanceOf(JournalProjectionStaleError)
  await prepared.close()
  await first.readers.close()
  await first.writer.close()

  const source = new Database(filename, { readonly: true })
  const saved = source.prepare('SELECT * FROM journal_outcomes ORDER BY seq,field,entry_key').all()
  const { writer, readers } = await workers(root, filename)
  const converter = new JournalSqlConversions(writer, readers, async () => {})
  converters.push(converter)
  expect(await converter.ensure('session')).toBe('epoch')
  expect(
    source.prepare('SELECT * FROM journal_outcomes ORDER BY seq,field,entry_key').all()
  ).toEqual(saved)
  source.close()
  const target = { sessionId: 'session', epoch: 'epoch', ownerToken: 'new-open' }
  await writer.write({
    target,
    operation: { kind: 'open' },
    facts: {
      identity: {
        sessionId: 'session',
        workspaceId: 'workspace',
        hostId: 'host',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      }
    }
  })
  const written = await writer.write({
    target,
    operation: {
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: 'after' },
      body: { kind: 'status', text: 'after conversion' },
      options: { fence: 1, turnScope: { kind: 'thread' } }
    }
  })
  expect(written.cursor.sequence).toBe(17)
  expect(await readers.read(history)).toMatchObject({
    ok: true,
    page: {
      liveCursor: { sequence: 17 },
      items: expect.arrayContaining([
        expect.objectContaining({
          itemId: 'orca:after',
          body: { kind: 'status', text: 'after conversion' }
        })
      ])
    }
  })
})

it('promotes the same paused background conversion when a chat opens', async () => {
  const { root, filename } = await fixture()
  const { writer, readers } = await workers(root, filename)
  const paused = Promise.withResolvers<void>()
  const converter = new JournalSqlConversions(writer, readers, async (promotion) => {
    paused.resolve()
    await new Promise<void>((_resolve, reject) => {
      promotion.addEventListener('abort', () => reject(promotion.reason), { once: true })
    })
  })
  converters.push(converter)
  const background = converter.ensure('session', false)
  await paused.promise
  const opened = converter.ensure('session')
  expect(await Promise.all([background, opened])).toEqual(['epoch', 'epoch'])
  expect(await readers.read(history)).toMatchObject({ ok: true, page: { sessionId: 'session' } })
})
