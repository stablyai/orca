import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleForeignSqliteReaderRequest } from './foreign-sqlite-reader-dispatch'

describe('handleForeignSqliteReaderRequest', () => {
  it('routes openCodeBinderSessions to its reader and reports a failed open as an error', () => {
    const request = { kind: 'openCodeBinderSessions' as const, cursor: { ms: 0, id: '' } }
    expect(
      handleForeignSqliteReaderRequest({
        ...request,
        id: 5,
        dbPath: '/definitely/missing/opencode.db'
      })
    ).toEqual({ id: 5, ok: true, value: [] })
    const dir = mkdtempSync(join(tmpdir(), 'orca-foreign-sqlite-dispatch-'))
    try {
      const dbPath = join(dir, 'opencode.db')
      writeFileSync(dbPath, 'not a sqlite database'.repeat(100))
      expect(handleForeignSqliteReaderRequest({ ...request, id: 6, dbPath })).toMatchObject({
        id: 6,
        ok: false
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
