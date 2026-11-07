import type { z } from 'zod'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge-caps'
import type { BridgeRpcClient } from './bridge-rpc-client'
import {
  BRIDGE_STORE_MAX_KEYS,
  BRIDGE_STORE_VERB,
  storeReadResultSchema,
  storeWriteResultSchema,
  type BridgeStoreParams,
  type BridgeStoreWriteResult
} from './bridge-store-verb'

type WriteParams = Extract<BridgeStoreParams, { action: 'write' }>
export type PageDeviceStoreTable = BridgeStoreParams['table']
export type PageDeviceStoreWriteOp = WriteParams['ops'][number]
export type PageDeviceStoreRead =
  | { readonly status: 'ok'; readonly values: readonly (string | null)[] }
  | { readonly status: 'unavailable' }

// Without the grant (an older shell) every call answers unavailable, and callers keep the value in
// memory as they did before the store existed.
export type PageDeviceStore = {
  readonly available: () => boolean
  read(table: PageDeviceStoreTable, keys: readonly string[]): Promise<PageDeviceStoreRead>
  // A large call goes in several batches; on a refusal, batches other than the refused one may still
  // have been written.
  write(
    table: PageDeviceStoreTable,
    ops: readonly PageDeviceStoreWriteOp[]
  ): Promise<BridgeStoreWriteResult>
}

// Room under the page-to-shell frame cap for the envelope. A key counts six times its length, its
// worst JSON escape.
const WRITE_FRAME_BUDGET_CHARS = BRIDGE_MAX_MESSAGE_BYTES - 40 * 1024
const OP_ENVELOPE_CHARS = 32

const READ_UNAVAILABLE = { status: 'unavailable' } as const
const WRITE_UNAVAILABLE = { written: false, refusal: 'unavailable' } as const

function opChars(op: PageDeviceStoreWriteOp): number {
  return OP_ENVELOPE_CHARS + op.key.length * 6 + (op.value?.length ?? 0)
}

function writeBatches(ops: readonly PageDeviceStoreWriteOp[]): PageDeviceStoreWriteOp[][] {
  const batches: PageDeviceStoreWriteOp[][] = []
  let batch: PageDeviceStoreWriteOp[] = []
  let chars = 0
  for (const op of ops) {
    const size = opChars(op)
    if (
      batch.length === BRIDGE_STORE_MAX_KEYS ||
      (batch.length > 0 && chars + size > WRITE_FRAME_BUDGET_CHARS)
    ) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push(op)
    chars += size
  }
  if (batch.length > 0) {
    batches.push(batch)
  }
  return batches
}

export function createPageDeviceStore(
  client: Pick<BridgeRpcClient, 'getShellSession' | 'callNativeVerb'>
): PageDeviceStore {
  const available = (): boolean =>
    client.getShellSession()?.grants.native.includes(BRIDGE_STORE_VERB) === true

  // A refusal or a dropped frame reads as unavailable: callers have one fallback, memory.
  async function call<Value>(
    params: BridgeStoreParams,
    result: z.ZodType<Value>
  ): Promise<Value | null> {
    try {
      return result.parse((await client.callNativeVerb(BRIDGE_STORE_VERB, params)).result)
    } catch (error) {
      console.warn('[device-store] the shell did not answer a store call', error)
      return null
    }
  }

  return {
    available,
    // Up to 64 keys a call; keys past the shell's reply budget come back deferred and go out again.
    async read(table, keys) {
      if (!available()) {
        return READ_UNAVAILABLE
      }
      const values: (string | null)[] = keys.map(() => null)
      let pending = keys.map((_key, at) => at)
      while (pending.length > 0) {
        const sent = pending.slice(0, BRIDGE_STORE_MAX_KEYS)
        const reply = await call(
          { action: 'read', table, keys: sent.map((at) => keys[at]!) },
          storeReadResultSchema
        )
        if (reply === null || 'refusal' in reply || reply.values.length !== sent.length) {
          return READ_UNAVAILABLE
        }
        sent.forEach((at, slot) => {
          values[at] = reply.values[slot] ?? null
        })
        const deferred = reply.deferred.flatMap((slot) => sent[slot] ?? [])
        // A reply that fills nothing would loop forever.
        if (deferred.length >= sent.length) {
          return READ_UNAVAILABLE
        }
        pending = [...deferred, ...pending.slice(sent.length)]
      }
      return { status: 'ok', values }
    },
    async write(table, ops) {
      if (!available()) {
        return WRITE_UNAVAILABLE
      }
      // One op too big for a frame is too big for the store too.
      if (ops.some((op) => opChars(op) > WRITE_FRAME_BUDGET_CHARS)) {
        return { written: false, refusal: 'too-large' }
      }
      // Posted back to back: the shell queues store calls in arrival order, so a call's batches stay
      // together, and a page that closes has already handed every batch over.
      const replies = await Promise.all(
        writeBatches(ops).map((batch) =>
          call({ action: 'write', table, ops: batch }, storeWriteResultSchema)
        )
      )
      for (const reply of replies) {
        if (reply === null) {
          return WRITE_UNAVAILABLE
        }
        if (!reply.written) {
          return reply
        }
      }
      return { written: true }
    }
  }
}
