import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { hasNodeSqliteReaderApi, NODE_SQLITE_READER_API_SOURCE } from './node-sqlite-reader-api'

const probe = (sqlite: unknown): unknown =>
  runInNewContext(`(${NODE_SQLITE_READER_API_SOURCE})(sqlite)`, { sqlite })

class DatabaseSync {}
const backup = async (): Promise<void> => {}

describe('node:sqlite reader admission', () => {
  it.each([
    ['DatabaseSync with backup (Node >= 22.16)', { DatabaseSync, backup }, true],
    ['DatabaseSync without backup (Node 22.13-22.15)', { DatabaseSync }, false],
    ['backup without DatabaseSync', { backup }, false],
    ['non-function DatabaseSync', { DatabaseSync: {}, backup }, false],
    ['non-function backup', { DatabaseSync, backup: true }, false],
    ['missing module', undefined, false],
    ['null module', null, false]
  ])('agrees in-process and in the embedded probe for %s', (_label, sqlite, admitted) => {
    expect(hasNodeSqliteReaderApi(sqlite)).toBe(admitted)
    expect(probe(sqlite)).toBe(admitted)
  })

  it('admits the actual runtime module', () => {
    const sqlite: unknown = process.getBuiltinModule('node:sqlite')
    expect(hasNodeSqliteReaderApi(sqlite)).toBe(true)
    expect(probe(sqlite)).toBe(true)
  })
})
