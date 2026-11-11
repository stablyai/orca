import * as z from 'zod'
import { BRIDGE_MAX_REPLY_BYTES } from './bridge-caps'

// The page's device store: one verb whose action picks read or write, so each route spends one grant.
// The shell binds the host; keys are the page's own strings and the shell gives them no meaning.
export const BRIDGE_STORE_VERB = 'native.store.rows'

export const BRIDGE_STORE_MAX_KEYS = 64

// 64 values at the store's 512 KiB cap would pass the reply cap, which refuses a reply whole. The shell
// stops filling values here, leaving room for the envelope, and lists the rest as deferred to read again.
export const BRIDGE_STORE_READ_REPLY_BUDGET_CHARS = BRIDGE_MAX_REPLY_BYTES - 2 * 1024 * 1024

const tableSchema = z.enum(['cache', 'draft'])
const keySchema = z.string().min(1).max(512)

// The shell refuses a whole call with any other key, so the page checks each key before sending it.
export function isBridgeStoreKey(key: string): boolean {
  return keySchema.safeParse(key).success
}

// Values are base64(gzip(JSON)) in both tables: the store seals the base64 string as the bytes it encodes.
export const storeParamsSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('read'),
    table: tableSchema,
    keys: z.array(keySchema).min(1).max(BRIDGE_STORE_MAX_KEYS)
  }),
  z.strictObject({
    action: z.literal('write'),
    table: tableSchema,
    ops: z
      .array(z.strictObject({ key: keySchema, value: z.string().nullable() }))
      .min(1)
      .max(BRIDGE_STORE_MAX_KEYS)
  })
])

export type BridgeStoreParams = z.infer<typeof storeParamsSchema>

// Values in key order; a deferred index holds null until the page reads that key again.
export const storeReadResultSchema = z.union([
  z.strictObject({
    values: z.array(z.string().nullable()),
    deferred: z.array(z.number().int().nonnegative())
  }),
  z.strictObject({ refusal: z.literal('unavailable') })
])

// Written only once every op is on disk, in op order.
export const storeWriteResultSchema = z.union([
  z.strictObject({ written: z.literal(true) }),
  z.strictObject({
    written: z.literal(false),
    refusal: z.enum(['too-large', 'over-cap', 'unavailable'])
  })
])

export const storeResultSchema = z.union([storeReadResultSchema, storeWriteResultSchema])

export type BridgeStoreReadResult = z.infer<typeof storeReadResultSchema>
export type BridgeStoreWriteResult = z.infer<typeof storeWriteResultSchema>
