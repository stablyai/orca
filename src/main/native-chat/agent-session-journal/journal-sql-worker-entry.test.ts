// @orca-isolated-worker -- This suite owns the worker entry's parent port.
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as WorkerThreads from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import * as domain from './database/journal-domain-database'
import { JournalSqlCommand } from './journal-sql-command'
import type { JournalSqlRequest, JournalSqlResponse } from './journal-sql-protocol'
import type { JournalSqlReaderReply, JournalSqlReaderRequest } from './journal-sql-reader-protocol'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'

it('commits fork installation with FULL durability and restores NORMAL before acknowledgement', async () => {
  const db = new Database(':memory:')
  db.pragma('synchronous=NORMAL')
  db.exec('CREATE TABLE installed (durability INTEGER NOT NULL)')
  const port = Object.assign(new EventEmitter(), {
    postMessage: (response: JournalSqlResponse) => port.emit('response', response),
    close: () => {}
  })
  vi.doMock('node:worker_threads', async (original) => ({
    ...(await original<typeof WorkerThreads>()),
    parentPort: port,
    workerData: { filename: ':memory:', stateDirectory: '/unused-journal-worker-test' }
  }))
  vi.doMock('./database/journal-checkpoint-owner', () => ({
    JournalCheckpointOwner: class {
      async beforeWrite() {}
      afterCommit() {}
      async close() {}
    }
  }))
  vi.spyOn(domain, 'openJournalDomainDatabase').mockReturnValue({ db, readOnly: false })
  // The command executor is independent of the worker's transaction/durability boundary.
  vi.spyOn(JournalSqlCommand.prototype, 'apply').mockImplementation(async () => {
    const durability = Number(db.pragma('synchronous', { simple: true }))
    db.prepare('INSERT INTO installed VALUES (?)').run(durability)
    return {
      cursor: { epoch: 'forked', sequence: 1 },
      inputChanged: false,
      keys: [],
      items: [],
      inputKeys: [],
      effects: []
    }
  })
  const request = async (input: JournalSqlRequest) => {
    const answer = new Promise<JournalSqlResponse>((resolve) => port.once('response', resolve))
    port.emit('message', input)
    return answer
  }
  try {
    const ready = once(port, 'response')
    await import('./journal-sql-worker-entry')
    expect((await ready)[0]).toEqual({ type: 'ready', readOnly: false })
    const result = await request({
      id: 1,
      command: {
        type: 'write',
        command: {
          target: { sessionId: 'child', epoch: 'empty', ownerToken: 'owner' },
          operation: { kind: 'fork-install' },
          forkInstall: { token: 'completed-stage', count: 0, lastItemId: null }
        }
      }
    })
    expect(result).toMatchObject({ type: 'committed', id: 1 })
    expect(db.prepare('SELECT durability FROM installed').all()).toEqual([{ durability: 2 }])
    expect(db.isTransaction).toBe(false)
    expect(db.pragma('synchronous', { simple: true })).toBe(1)
    expect(await request({ id: 2, command: { type: 'close' } })).toEqual({ type: 'done', id: 2 })
  } finally {
    vi.restoreAllMocks()
    vi.doUnmock('node:worker_threads')
    vi.doUnmock('./database/journal-checkpoint-owner')
    try {
      db.close()
    } catch {}
  }
})

it('retires a reader when fork construction and its cleanup both fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-fork-constructor-'))
  const filename = join(directory, 'source.sqlite')
  const writer = new Database(filename)
  writer.pragma('journal_mode=WAL')
  const replies: JournalSqlReaderReply[] = []
  const port = Object.assign(new EventEmitter(), {
    postMessage: (reply: JournalSqlReaderReply) => replies.push(reply),
    close: vi.fn()
  })
  vi.doMock('node:worker_threads', async (original) => ({
    ...(await original<typeof WorkerThreads>()),
    parentPort: port,
    workerData: { filename, originalFilename: filename }
  }))
  const primary = new Error('injected fork workspace creation failure')
  const exec = Database.prototype.exec
  const disposed = new Set<Database.Database>()
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
    if (sql.startsWith('CREATE TEMP TABLE')) {
      disposed.add(this)
      throw primary
    }
    if (sql.startsWith('DROP TABLE')) {
      throw new Error('secondary constructor cleanup failure')
    }
    exec.call(this, sql)
  })
  try {
    await import('./journal-sql-reader-entry')
    expect(replies).toEqual([{ type: 'ready' }])
    const request: JournalSqlReaderRequest = {
      id: 1,
      operation: {
        kind: 'fork-prepare',
        input: {
          source: {
            sessionId: 'source',
            throughItemId: 'boundary',
            capability: 'tip',
            retained: 'frozen',
            location: agentSessionRecordFixture({ sessionId: 'source' }).location,
            submissionsToken: null
          }
        }
      }
    }
    port.emit('message', request)
    expect(replies[1]).toMatchObject({
      type: 'failed',
      error: { name: 'Error', message: 'injected fork workspace creation failure' }
    })
    expect(replies[1]).not.toHaveProperty('id')
    expect(port.close).toHaveBeenCalledOnce()
    const connection = [...disposed][0]
    expect(connection).toBeDefined()
    expect(() => connection!.prepare('SELECT 1').get()).toThrow()
  } finally {
    vi.restoreAllMocks()
    vi.doUnmock('node:worker_threads')
    port.removeAllListeners()
    for (const connection of disposed) {
      try {
        connection.close()
      } catch {}
    }
    writer.close()
    await rm(directory, { recursive: true, force: true })
  }
})
