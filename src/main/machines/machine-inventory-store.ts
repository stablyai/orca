import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import type { MachineInventoryStore } from '../../shared/machine-inventory'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

const MACHINE_INVENTORY_FILE = 'orca-machines.json'
const MAX_MACHINE_INVENTORY_BYTES = 4 * 1024 * 1024

// Shallow on purpose: this build wrote the rows, and unknown fields from a newer build must survive.
const storeSchema = z.object({
  version: z.number().int().positive(),
  providers: z.record(
    z.string(),
    z
      .object({
        machines: z.array(z.object({ id: z.string(), providerKey: z.string() }).passthrough()),
        pendingCreates: z.array(z.object({ operationId: z.string() }).passthrough())
      })
      .passthrough()
  )
})

export function getMachineInventoryStorePath(userDataPath: string): string {
  return join(userDataPath, MACHINE_INVENTORY_FILE)
}

export function emptyMachineInventoryStore(): MachineInventoryStore {
  return { version: 1, providers: {} }
}

export type LoadedMachineInventoryStore = { store: MachineInventoryStore; writable: boolean }

/** A file from a newer build is never overwritten; this build then works from memory only. */
export function readMachineInventoryStore(userDataPath: string): LoadedMachineInventoryStore {
  let json: unknown
  try {
    const { buffer } = readNodeFileSyncWithinLimit(
      getMachineInventoryStorePath(userDataPath),
      MAX_MACHINE_INVENTORY_BYTES,
      { regularFileOnly: true }
    )
    json = JSON.parse(buffer.toString('utf8'))
  } catch {
    // Missing or unreadable: rows are a cache of provider state and refill on the next list.
    return { store: emptyMachineInventoryStore(), writable: true }
  }
  const parsed = storeSchema.safeParse(json)
  if (!parsed.success) {
    return { store: emptyMachineInventoryStore(), writable: true }
  }
  if (parsed.data.version !== 1) {
    return { store: emptyMachineInventoryStore(), writable: false }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this module writes version 1, from a MachineInventoryStore; the schema checks the shape every reader indexes into.
  return { store: parsed.data as MachineInventoryStore, writable: true }
}

export function writeMachineInventoryStore(
  userDataPath: string,
  store: MachineInventoryStore
): void {
  writeSecureJsonFileWithinLimit(
    getMachineInventoryStorePath(userDataPath),
    store,
    MAX_MACHINE_INVENTORY_BYTES,
    { durable: true }
  )
}
