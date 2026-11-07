import { QueryClient } from '@tanstack/react-query'
import {
  experimental_createQueryPersister,
  type PersistedQuery
} from '@tanstack/query-persist-client-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrcaQueryStorage, type OrcaQueryStoreBackend } from './query-storage'

function memoryBackend(hostId: string) {
  const rows = new Map<string, string>()
  const backend: OrcaQueryStoreBackend = {
    hostId,
    read: async (keys) => ({ status: 'ok', values: keys.map((key) => rows.get(key) ?? null) }),
    write: async (ops) => {
      // Like `native.store.rows`, a key over 512 characters refuses the whole call.
      if (ops.some((op) => op.key.length > 512)) {
        return { written: false }
      }
      for (const op of ops) {
        if (op.value === null) {
          rows.delete(op.key)
        } else {
          rows.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  }
  return { backend, rows }
}

function persisterOver(
  storage: ReturnType<typeof createOrcaQueryStorage>,
  prefix = 'q1|worktree.ps@1'
) {
  return experimental_createQueryPersister<PersistedQuery>({
    storage,
    prefix,
    serialize: (query) => query,
    deserialize: (query) => query
  })
}

describe('createOrcaQueryStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_794_000_000_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("stores only queries keyed ['orca', <bridge host>, ...], deep paths included", async () => {
    const memory = memoryBackend('host-a')
    const storage = createOrcaQueryStorage(memory.backend)
    const persister = persisterOver(storage, 'q1|files.dir@1')
    const client = new QueryClient()
    const relativePath = Array(12).fill('packages/very-deeply-nested-workspace-folder').join('/')
    const ownKey = ['orca', 'host-a', 'files.dir', { exec: 'local' }, { relativePath }]
    const otherHostKey = ['orca', 'host-b', 'files.dir', { exec: 'local' }, {}]
    const foreignKey = ['other', 'host-a', 'files.dir']
    for (const queryKey of [ownKey, otherHostKey, foreignKey]) {
      client.setQueryData(queryKey, { entries: ['README.md'] })
      await persister.persistQueryByKey(queryKey, client)
    }
    await storage.flush()

    // sha256 of the 620-character storage key of `ownKey`.
    expect([...memory.rows.keys()]).toEqual([
      '1b7af21ba777cb9df9bb4374b31946114af6196c3ec2cb1a478743c4aed03d0b'
    ])
    // A later document reads the stored record back.
    const nextDocument = persisterOver(createOrcaQueryStorage(memory.backend), 'q1|files.dir@1')
    await expect(
      nextDocument.retrieveQuery(
        `["orca","host-a","files.dir",{"exec":"local"},{"relativePath":"${relativePath}"}]`
      )
    ).resolves.toEqual({ entries: ['README.md'] })
  })

  it('keeps the stored copy of unchanged data until it is a minute old', async () => {
    const memory = memoryBackend('host-a')
    const storage = createOrcaQueryStorage(memory.backend)
    const persister = persisterOver(storage)
    const client = new QueryClient()
    const queryKey = ['orca', 'host-a', 'worktree.ps', { exec: 'local' }, {}]
    const startedAt = 1_794_000_000_000
    const persistAt = async (rows: string[], updatedAt: number) => {
      client.setQueryData(queryKey, { rows }, { updatedAt })
      await persister.persistQueryByKey(queryKey, client)
      await storage.flush()
    }
    const stored = () =>
      createOrcaQueryStorage(memory.backend).getItem(
        'q1|worktree.ps@1-["orca","host-a","worktree.ps",{"exec":"local"},{}]'
      )

    await persistAt(['main'], startedAt)
    await persistAt(['main'], startedAt + 3_000)
    expect((await stored())?.state.dataUpdatedAt).toBe(startedAt)

    await persistAt(['main'], startedAt + 61_000)
    expect((await stored())?.state.dataUpdatedAt).toBe(startedAt + 61_000)

    await persistAt(['main', 'feature'], startedAt + 62_000)
    expect((await stored())?.state.data).toEqual({ rows: ['main', 'feature'] })
  })
})
