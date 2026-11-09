import { DEVICE_STORE_MAX_VALUE_LENGTH } from '../../device-store/device-store-value-codec'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge-caps'
import type { BridgeRpcClient } from './bridge-rpc-client'
import {
  BRIDGE_STORE_MAX_KEYS,
  BRIDGE_STORE_VERB,
  isBridgeStoreKey,
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
// 'bad-key' is the page's own refusal: a key the store can't hold (keys run 1-512 characters).
export type PageDeviceStoreWriteResult =
  | BridgeStoreWriteResult
  | { readonly written: false; readonly refusal: 'bad-key' }

// Without the grant (an older shell) every call answers unavailable, and callers keep the value in
// memory as they did before the store existed.
export type PageDeviceStore = {
  readonly available: () => boolean
  // A key the store can't hold reads as a miss.
  read(table: PageDeviceStoreTable, keys: readonly string[]): Promise<PageDeviceStoreRead>
  // A bad key or a value over the store's cap refuses the call before anything is written. A large call
  // goes in several batches; on a refusal, batches other than the refused one may still have been written.
  write(
    table: PageDeviceStoreTable,
    ops: readonly PageDeviceStoreWriteOp[]
  ): Promise<PageDeviceStoreWriteResult>
}

// Room under the page-to-shell frame cap for the envelope. A key counts six times its length, its
// worst JSON escape.
const WRITE_FRAME_BUDGET_CHARS = BRIDGE_MAX_MESSAGE_BYTES - 40 * 1024
const OP_ENVELOPE_CHARS = 32
// A quarter of the bridge's 64 request slots: every batch of a typical flush still goes out at once.
const STORE_CALLS_IN_FLIGHT = 16
// Attach Photos and its cleanup must still get through when desktop calls hold the rest.
const NATIVE_ROOM_LEFT_FOR_OTHER_VERBS = 2
const CAP_RETRY_MS = 50

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

// Deferred slots must name distinct keys of the call that came back empty; anything else is a bad reply.
function readsDeferred(deferred: readonly number[], values: readonly (string | null)[]): boolean {
  return (
    new Set(deferred).size === deferred.length &&
    deferred.every((slot) => slot < values.length && values[slot] === null)
  )
}

// Store calls go to the shell as soon as they are made, in call order, so a page that closes has already
// handed them over and the shell's arrival order keeps a later write from landing under an earlier one.
// Past the store's share of the bridge's in-flight cap, or when other calls fill it, calls wait here in order
// and go out as room appears: a large write never has a batch refused, and leaves most slots to desktop
// calls and other device verbs. Resolves null for a call that failed.
function createStoreLane(client: Pick<BridgeRpcClient, 'callNativeVerb' | 'nativeRequestRoom'>) {
  const waiting: {
    readonly params: BridgeStoreParams
    readonly settle: (result: unknown) => void
  }[] = []
  let inFlight = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  const drain = (): void => {
    while (
      waiting.length > 0 &&
      inFlight < STORE_CALLS_IN_FLIGHT &&
      client.nativeRequestRoom() > NATIVE_ROOM_LEFT_FOR_OTHER_VERBS
    ) {
      const { params, settle } = waiting.shift()!
      inFlight += 1
      void (async () => (await client.callNativeVerb(BRIDGE_STORE_VERB, params)).result)()
        .catch((error: unknown) => {
          console.warn('[device-store] the shell did not answer a store call', error)
          return null
        })
        .then((result) => {
          inFlight -= 1
          settle(result)
          drain()
        })
    }
    // Other calls free room without telling the store, so a lane blocked by them looks again shortly.
    if (waiting.length > 0 && inFlight === 0) {
      retry ??= setTimeout(() => {
        retry = null
        drain()
      }, CAP_RETRY_MS)
    }
  }
  return (params: BridgeStoreParams): Promise<unknown> =>
    new Promise((settle) => {
      waiting.push({ params, settle })
      drain()
    })
}

export function createPageDeviceStore(
  client: Pick<BridgeRpcClient, 'getShellSession' | 'callNativeVerb' | 'nativeRequestRoom'>
): PageDeviceStore {
  const available = (): boolean =>
    client.getShellSession()?.grants.native.includes(BRIDGE_STORE_VERB) === true
  const call = createStoreLane(client)

  return {
    available,
    // Up to 64 keys a call; keys past the shell's reply budget come back deferred and go out again.
    // A refusal or a dropped frame reads as unavailable: callers have one fallback, memory.
    async read(table, keys) {
      if (!available()) {
        return READ_UNAVAILABLE
      }
      const values: (string | null)[] = keys.map(() => null)
      let pending = keys.flatMap((key, at) => (isBridgeStoreKey(key) ? [at] : []))
      while (pending.length > 0) {
        const sent = pending.slice(0, BRIDGE_STORE_MAX_KEYS)
        const reply = storeReadResultSchema.safeParse(
          await call({ action: 'read', table, keys: sent.map((at) => keys[at]!) })
        )
        if (
          !reply.success ||
          'refusal' in reply.data ||
          reply.data.values.length !== sent.length ||
          !readsDeferred(reply.data.deferred, reply.data.values)
        ) {
          return READ_UNAVAILABLE
        }
        const { values: replied, deferred: deferredSlots } = reply.data
        sent.forEach((at, slot) => {
          values[at] = replied[slot] ?? null
        })
        const deferred = deferredSlots.map((slot) => sent[slot]!)
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
      if (ops.some((op) => !isBridgeStoreKey(op.key))) {
        return { written: false, refusal: 'bad-key' }
      }
      // Checked here so an earlier batch is never written before a later one is refused; a value under
      // the cap with a key under 512 characters always fits one frame.
      if (ops.some((op) => op.value !== null && op.value.length > DEVICE_STORE_MAX_VALUE_LENGTH)) {
        return { written: false, refusal: 'too-large' }
      }
      const replies = await Promise.all(
        writeBatches(ops).map((batch) => call({ action: 'write', table, ops: batch }))
      )
      for (const result of replies) {
        const reply = storeWriteResultSchema.safeParse(result)
        if (!reply.success || !reply.data.written) {
          return reply.success ? reply.data : WRITE_UNAVAILABLE
        }
      }
      return { written: true }
    }
  }
}

// Published at page boot, like page storage, so plain modules (draft rows) can reach the store.
let pageDeviceStore: PageDeviceStore | null = null

export function publishPageDeviceStore(store: PageDeviceStore | null): void {
  pageDeviceStore = store
}

/** Null outside a page; an older shell's store answers unavailable. */
export function readPageDeviceStore(): PageDeviceStore | null {
  return pageDeviceStore
}
