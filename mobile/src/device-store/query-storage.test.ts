import { QueryClient } from '@tanstack/react-query'
import {
  experimental_createQueryPersister,
  type PersistedQuery
} from '@tanstack/query-persist-client-core'
import { describe, expect, it } from 'vitest'
import { createOrcaQueryStorage, type OrcaQueryStoreBackend } from './query-storage'

type WriteOps = Parameters<OrcaQueryStoreBackend['write']>[0]

function memoryBackend(hostId: string) {
  const rows = new Map<string, string>()
  const writes: WriteOps[] = []
  const backend: OrcaQueryStoreBackend = {
    hostId,
    read: async (keys) => ({ status: 'ok', values: keys.map((key) => rows.get(key) ?? null) }),
    write: async (ops) => {
      writes.push(ops)
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
  return { backend, rows, writes }
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

  it('writes a refetch that kept the same data once, until the stored copy is a minute old', async () => {
    const memory = memoryBackend('host-a')
    const storage = createOrcaQueryStorage(memory.backend)
    const persister = persisterOver(storage)
    const client = new QueryClient()
    const queryKey = ['orca', 'host-a', 'worktree.ps', { exec: 'local' }, {}]
    const startedAt = Date.now()
    const persistAt = async (rows: string[], updatedAt: number) => {
      client.setQueryData(queryKey, { rows }, { updatedAt })
      await persister.persistQueryByKey(queryKey, client)
      await storage.flush()
    }

    await persistAt(['main'], startedAt)
    await persistAt(['main'], startedAt + 3_000)
    expect(memory.writes).toHaveLength(1)

    await persistAt(['main', 'feature'], startedAt + 6_000)
    await persistAt(['main', 'feature'], startedAt + 6_000 + 61_000)
    expect(memory.writes).toHaveLength(3)
  })
})
