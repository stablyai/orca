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

function persisterOver(storage: ReturnType<typeof createOrcaQueryStorage>) {
  return experimental_createQueryPersister<PersistedQuery>({
    storage,
    prefix: 'q1|worktree.ps@1',
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

  it("never writes a query whose key isn't ['orca', <bridge host>, ...]", async () => {
    const memory = memoryBackend('host-a')
    const storage = createOrcaQueryStorage(memory.backend)
    const persister = persisterOver(storage)
    const client = new QueryClient()
    const ownKey = ['orca', 'host-a', 'worktree.ps', { exec: 'local' }, {}]
    const otherHostKey = ['orca', 'host-b', 'worktree.ps', { exec: 'local' }, {}]
    const foreignKey = ['other', 'host-a', 'worktree.ps']
    for (const queryKey of [ownKey, otherHostKey, foreignKey]) {
      client.setQueryData(queryKey, { rows: ['main'] })
      await persister.persistQueryByKey(queryKey, client)
    }
    await storage.flush()

    expect([...memory.rows.keys()]).toEqual([
      'q1|worktree.ps@1-["orca","host-a","worktree.ps",{"exec":"local"},{}]'
    ])
    // A later document reads the stored record back.
    const nextDocument = persisterOver(createOrcaQueryStorage(memory.backend))
    await expect(
      nextDocument.retrieveQuery('["orca","host-a","worktree.ps",{"exec":"local"},{}]')
    ).resolves.toEqual({ rows: ['main'] })
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
