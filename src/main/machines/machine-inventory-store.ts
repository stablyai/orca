import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import type { MachineInventoryStore } from '../../shared/machine-inventory'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

const MACHINE_INVENTORY_FILE = 'orca-machines.json'
const MAX_MACHINE_INVENTORY_BYTES = 4 * 1024 * 1024

const optionalText = z.string().optional()
const optionalNumber = z.number().optional()

/** Every field readers use without checking; unknown fields from a newer build survive. */
const recordSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    providerKey: z.string().regex(/^plugin:.+\/[^/]+$/),
    lifetime: z.enum(['persistent', 'temporary']),
    state: z.string(),
    createdAt: z.string(),
    lastSeenAt: z.number(),
    expiresAt: optionalText,
    lastError: optionalText,
    sshTargetId: optionalText,
    runtimeEnvironmentId: optionalText,
    managedEnvironmentId: optionalText,
    pairingCodeSha256: optionalText,
    creatingOperationId: optionalText
  })
  .passthrough()

const pendingCreateSchema = z
  .object({
    operationId: z.string(),
    startedAt: z.number(),
    name: z.string(),
    lifetime: z.enum(['persistent', 'temporary'])
  })
  .passthrough()

/** One unreadable row is dropped, never the whole inventory: rows are a cache providers refill. */
function rowsOf<T extends z.ZodType>(schema: T) {
  return z.array(z.unknown()).transform((rows) =>
    rows.flatMap((row) => {
      const parsed = schema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  )
}

const storeSchema = z.object({
  version: z.number().int().positive(),
  providers: z.record(
    z.string(),
    z
      .object({
        contextId: optionalText,
        clockOffsetMs: optionalNumber,
        listedAt: optionalNumber,
        lastFailure: z
          .object({ code: z.string(), message: z.string(), at: z.number() })
          .optional()
          .catch(undefined),
        machines: rowsOf(recordSchema),
        pendingCreates: rowsOf(pendingCreateSchema)
      })
      .passthrough()
  ),
  warnedExpiries: z.array(z.string()).optional()
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema checks every field readers use unchecked; what it leaves loose (state, access, capabilities) only this module writes, from a MachineInventoryStore, and readers re-validate state through machine-display.
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
