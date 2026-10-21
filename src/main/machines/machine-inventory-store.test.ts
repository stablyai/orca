import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getMachineInventoryStorePath, readMachineInventoryStore } from './machine-inventory-store'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeWith(contents: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-machine-store-'))
  roots.push(root)
  await writeFile(getMachineInventoryStorePath(root), JSON.stringify(contents))
  return root
}

const row = {
  id: 'sbx-1',
  name: 'dev',
  providerKey: 'plugin:acme.omarchy/omarchy',
  lifetime: 'persistent',
  state: 'running',
  createdAt: '2026-10-18T00:00:00Z',
  lastSeenAt: 1
}

describe('readMachineInventoryStore', () => {
  it('drops a malformed row but keeps the rest of the inventory', async () => {
    const root = await storeWith({
      version: 1,
      providers: {
        p: {
          machines: [row, { ...row, id: 'sbx-2', lastSeenAt: 'yesterday' }, { id: 'sbx-3' }],
          pendingCreates: [{ operationId: 'op-1' }]
        }
      }
    })
    const { store, writable } = readMachineInventoryStore(root)
    expect(writable).toBe(true)
    expect(store.providers.p?.machines.map((machine) => machine.id)).toEqual(['sbx-1'])
    expect(store.providers.p?.pendingCreates).toEqual([])
  })

  it('keeps fields a newer build wrote', async () => {
    const root = await storeWith({
      version: 1,
      providers: { p: { machines: [{ ...row, futureField: 7 }], pendingCreates: [] } }
    })
    expect(readMachineInventoryStore(root).store.providers.p?.machines[0]).toMatchObject({
      futureField: 7
    })
  })

  it('never writes over a file from a newer version', async () => {
    const root = await storeWith({ version: 2, providers: {} })
    expect(readMachineInventoryStore(root).writable).toBe(false)
  })
})
