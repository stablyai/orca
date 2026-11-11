import type * as NodeFs from 'node:fs'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../../../shared/windows-transient-lock-removal'
import '../../ai-vault/session-scanner-record-value'
import '../../sqlite/sync-database'
import { openSessionSearchDatabase } from './session-search-schema'
import { removeVersionedCacheDatabase } from '../../sqlite/versioned-cache-database'

const recordedRmSync = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      recordedRmSync(...args)
      return actual.rmSync(...args)
    }
  }
})

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => removeTree(root)))
  roots = []
})

async function tempDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-schema-'))
  roots.push(root)
  return join(root, 'index.sqlite')
}

describe('openSessionSearchDatabase', () => {
  it('keeps a version 8 index that predates prefix hashes and adds the column', async () => {
    const path = await tempDatabasePath()
    const first = openSessionSearchDatabase(path)
    first.exec('ALTER TABLE files DROP COLUMN prefix_hash')
    first.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
    first.close()

    const second = openSessionSearchDatabase(path)
    expect(second.prepare('SELECT path, prefix_hash FROM files').all()).toEqual([
      { path: 'a', prefix_hash: null }
    ])
    second.close()
  })

  it('removes the database with every sidecar', async () => {
    const path = await tempDatabasePath()
    openSessionSearchDatabase(path).close()
    await writeFile(`${path}-shm`, '')
    removeVersionedCacheDatabase(path)
    for (const suffix of ['', '-wal', '-shm']) {
      await expect(stat(`${path}${suffix}`)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  })
})
