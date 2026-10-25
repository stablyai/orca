import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', { spy: true })

const reads = vi.hoisted(() => ({
  binder: vi.fn<() => Promise<unknown[]>>(),
  client: vi.fn()
}))

vi.mock('./foreign-sqlite-reader-client', () => ({
  ForeignSqliteReaderClient: class {
    constructor() {
      reads.client()
    }

    readOpenCodeBinderSessions = reads.binder
  }
}))

import { readOpenCodeBinderSessions } from './foreign-sqlite-reader-spawn'

const CURSOR = { ms: 0, id: '' }
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-binder-preflight-'))
  reads.binder.mockReset().mockResolvedValue([])
  reads.client.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('OpenCode binder worker admission', () => {
  it.each(['ENOENT', 'ENOTDIR'])('does not dispatch a worker read for %s', async (code) => {
    const parent = join(root, 'parent')
    if (code === 'ENOTDIR') {
      writeFileSync(parent, '')
    }
    const path = join(parent, 'opencode.db')

    expect(await readOpenCodeBinderSessions(path, CURSOR)).toEqual([])
    expect(await readOpenCodeBinderSessions(path, CURSOR)).toEqual([])
    expect(reads.binder).not.toHaveBeenCalled()
    expect(reads.client).not.toHaveBeenCalled()
  })

  it('dispatches once the previously absent database appears', async () => {
    const path = join(root, 'later', 'opencode.db')
    expect(await readOpenCodeBinderSessions(path, CURSOR)).toEqual([])
    expect(reads.binder).not.toHaveBeenCalled()

    mkdirSync(join(root, 'later'))
    writeFileSync(path, '')
    const rows = [{ id: 'session', directory: root, createdAtMs: 1, parentId: null }]
    reads.binder.mockResolvedValue(rows)

    expect(await readOpenCodeBinderSessions(path, CURSOR)).toEqual(rows)
    expect(reads.binder).toHaveBeenCalledExactlyOnceWith(path, CURSOR)
  })

  it.each(['EACCES', 'EIO'])(
    'leaves %s failures to the existing worker error handling',
    async (code) => {
      const path = join(root, 'opencode.db')
      vi.mocked(fsPromises.stat).mockRejectedValueOnce(Object.assign(new Error(code), { code }))

      expect(await readOpenCodeBinderSessions(path, CURSOR)).toEqual([])
      expect(reads.binder).toHaveBeenCalledExactlyOnceWith(path, CURSOR)
    }
  )

  it('keeps the worker result authoritative when the database changes after the preflight', async () => {
    const path = join(root, 'opencode.db')
    writeFileSync(path, '')
    reads.binder.mockImplementation(async () => {
      rmSync(path)
      return []
    })

    expect(await readOpenCodeBinderSessions(path, CURSOR)).toEqual([])
    expect(reads.binder).toHaveBeenCalledExactlyOnceWith(path, CURSOR)
  })
})
