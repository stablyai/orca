import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CloudDatabase,
  openCloudDatabase,
  openInMemoryCloudDatabase
} from './cloud-database.js'

const postgresUrl = process.env.ORCA_CLOUD_DATABASE_TEST_URL
const opened: CloudDatabase[] = []
const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-database-after-commit-'))

afterEach(async () => {
  await Promise.all(opened.splice(0).map((database) => database.close()))
  vi.restoreAllMocks()
})

process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))

const dialects: [string, () => Promise<CloudDatabase>][] = [
  ['sqlite', () => openInMemoryCloudDatabase([])],
  ...(postgresUrl
    ? [
        [
          'postgres',
          () =>
            openCloudDatabase({
              service: 'after-commit-test',
              schemaStatements: [],
              databaseUrl: postgresUrl,
              dataDir
            })
        ] as [string, () => Promise<CloudDatabase>]
      ]
    : [])
]

describe.each(dialects)('afterCommit (%s)', (_name, open) => {
  async function database(): Promise<CloudDatabase> {
    const db = await open()
    opened.push(db)
    return db
  }

  it('runs once after commit, joins nested transactions, survives a throwing callback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = await database()
    const events: string[] = []
    let handle: CloudDatabase | undefined
    await db.transaction(async (transaction) => {
      handle = transaction
      transaction.afterCommit(() => {
        throw new Error('boom')
      })
      transaction.afterCommit(() => events.push('outer'))
      await transaction.transaction(async (inner) => {
        inner.afterCommit(() => events.push('nested'))
      })
      events.push('body')
    })
    expect(events).toEqual(['body', 'outer', 'nested'])
    expect(() => handle!.afterCommit(() => undefined)).toThrow()
    expect(() => db.afterCommit(() => undefined)).toThrow('after_commit_requires_transaction')
  })

  it('runs nothing on rollback', async () => {
    const db = await database()
    const ran = vi.fn()
    await expect(
      db.transaction(async (transaction) => {
        transaction.afterCommit(ran)
        throw new Error('rollback')
      })
    ).rejects.toThrow('rollback')
    expect(ran).not.toHaveBeenCalled()
  })
})

describe.skipIf(!postgresUrl)('afterCommit (postgres retry)', () => {
  it('drops the callbacks of a retried attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = await openCloudDatabase({
      service: 'after-commit-test',
      schemaStatements: [],
      databaseUrl: postgresUrl,
      dataDir
    })
    opened.push(db)
    const ran: number[] = []
    let attempt = 0
    await db.transaction(async (transaction) => {
      const current = ++attempt
      transaction.afterCommit(() => ran.push(current))
      if (current === 1) {
        throw Object.assign(new Error('serialization'), { code: '40001' })
      }
    })
    expect(ran).toEqual([2])
  })
})
