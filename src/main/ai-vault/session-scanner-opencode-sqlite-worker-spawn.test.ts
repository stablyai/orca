import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FOREIGN_SQLITE_READER_ENTRY_FILENAME as ENTRY } from '../foreign-sqlite-readers/foreign-sqlite-reader-entry-path'
import { resolveOpenCodeSqliteWorkerEntryPath } from './session-scanner-opencode-sqlite-worker-spawn'

describe('resolveOpenCodeSqliteWorkerEntryPath', () => {
  it('resolves a worker adjacent to an entry bundle', () => {
    const runtimeDir = join('out', 'main')
    const expected = join(runtimeDir, ENTRY)

    expect(resolveOpenCodeSqliteWorkerEntryPath(runtimeDir, (path) => path === expected)).toBe(
      expected
    )
  })

  it('resolves a root worker from a shared Rollup chunk', () => {
    const runtimeDir = join('out', 'main', 'chunks')
    const expected = join('out', 'main', ENTRY)

    expect(resolveOpenCodeSqliteWorkerEntryPath(runtimeDir, (path) => path === expected)).toBe(
      expected
    )
  })
})
