import { getHeapStatistics } from 'node:v8'
import {
  getEnvironmentData,
  isMainThread,
  parentPort,
  setEnvironmentData,
  threadId
} from 'node:worker_threads'
import { describeWorkerMessage } from './worker-message-shape'
import type { WorkerThreadRole } from './worker-thread-roles'

/**
 * Each worker writes what it last posted to its parent into shared memory before posting, so the
 * main thread's diagnostics and the hang watchdog can name a sender even when the main thread is
 * stuck receiving that message. Fixed size: SLOTS workers, no allocation per send.
 */
const LEDGER_KEY = 'orca.worker-send-ledger.v1'
const SLOTS = 48
const SLOT_BYTES = 176
const TEXT_BYTES = 40
const OWNER = 0
const SENDS = 4
const LAST_AT = 8
const LAST_BYTES = 16
const LAST_ITEMS = 24
const MAX_BYTES = 32
const HEAP_USED = 40
const LAST_DEPTH = 48
const LAST_TRUNCATED = 52
const ROLE = 56
const LAST_KIND = ROLE + TEXT_BYTES
const MAX_KIND = LAST_KIND + TEXT_BYTES

export type WorkerSendLedgerEntry = {
  role: string
  threadId: number
  sends: number
  lastAt: number
  lastKind: string
  lastItems: number
  lastBytes: number
  lastDepth: number
  lastTruncated: boolean
  maxKind: string
  maxBytes: number
  heapUsedMB: number
}

function sharedLedger(): SharedArrayBuffer | undefined {
  const ledger = getEnvironmentData(LEDGER_KEY)
  return ledger instanceof SharedArrayBuffer ? ledger : undefined
}

/** Main thread, before spawning: workers created afterwards inherit the ledger. */
export function ensureWorkerSendLedger(): void {
  if (isMainThread && !sharedLedger()) {
    setEnvironmentData(LEDGER_KEY, new SharedArrayBuffer(SLOTS * SLOT_BYTES))
  }
}

function writeText(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < TEXT_BYTES; index += 1) {
    const code = index < TEXT_BYTES - 1 && index < text.length ? text.charCodeAt(index) : 0
    view.setUint8(offset + index, code > 0x7e || (code < 0x20 && code !== 0) ? 0x3f : code)
  }
}

function readText(view: DataView, offset: number): string {
  let text = ''
  for (let index = 0; index < TEXT_BYTES; index += 1) {
    const code = view.getUint8(offset + index)
    if (code === 0) {
      break
    }
    text += String.fromCharCode(code)
  }
  return text
}

function claimSlot(ledger: SharedArrayBuffer, owner: number): DataView | undefined {
  const owners = new Int32Array(ledger)
  for (let slot = 0; slot < SLOTS; slot += 1) {
    if (Atomics.compareExchange(owners, (slot * SLOT_BYTES) / 4, 0, owner) === 0) {
      return new DataView(ledger, slot * SLOT_BYTES, SLOT_BYTES)
    }
  }
  return undefined
}

/** Worker side, once at startup. Recording never blocks or fails the post itself. */
export function installWorkerSendLedger(role: WorkerThreadRole): void {
  const port = parentPort
  const ledger = sharedLedger()
  if (isMainThread || !port || !ledger) {
    return
  }
  const slot = claimSlot(ledger, threadId)
  if (!slot) {
    return
  }
  writeText(slot, ROLE, role)
  const post = port.postMessage.bind(port) as (value: unknown, transfer?: unknown) => void
  port.postMessage = ((value: unknown, transfer?: unknown) => {
    try {
      recordSend(slot, value)
    } catch {
      // Diagnostics only.
    }
    post(value, transfer)
  }) as typeof port.postMessage
}

function recordSend(slot: DataView, value: unknown): void {
  const shape = describeWorkerMessage(value)
  slot.setInt32(SENDS, slot.getInt32(SENDS, true) + 1, true)
  slot.setFloat64(LAST_AT, Date.now(), true)
  slot.setFloat64(LAST_BYTES, shape.bytes, true)
  slot.setFloat64(LAST_ITEMS, shape.items, true)
  slot.setInt32(LAST_DEPTH, shape.depth, true)
  slot.setInt32(LAST_TRUNCATED, shape.truncated ? 1 : 0, true)
  writeText(slot, LAST_KIND, shape.kind)
  if (shape.bytes > slot.getFloat64(MAX_BYTES, true)) {
    slot.setFloat64(MAX_BYTES, shape.bytes, true)
    writeText(slot, MAX_KIND, shape.kind)
  }
  slot.setFloat64(HEAP_USED, getHeapStatistics().used_heap_size, true)
}

/** Readers may see a slot mid-write; every field is independently meaningful. */
export function readWorkerSendLedger(): WorkerSendLedgerEntry[] {
  const ledger = sharedLedger()
  if (!ledger) {
    return []
  }
  const owners = new Int32Array(ledger)
  const entries: WorkerSendLedgerEntry[] = []
  for (let slot = 0; slot < SLOTS; slot += 1) {
    const owner = Atomics.load(owners, (slot * SLOT_BYTES) / 4)
    if (owner === 0) {
      continue
    }
    const view = new DataView(ledger, slot * SLOT_BYTES, SLOT_BYTES)
    entries.push({
      role: readText(view, ROLE),
      threadId: owner,
      sends: view.getInt32(SENDS, true),
      lastAt: view.getFloat64(LAST_AT, true),
      lastKind: readText(view, LAST_KIND),
      lastItems: view.getFloat64(LAST_ITEMS, true),
      lastBytes: view.getFloat64(LAST_BYTES, true),
      lastDepth: view.getInt32(LAST_DEPTH, true),
      lastTruncated: view.getInt32(LAST_TRUNCATED, true) === 1,
      maxKind: readText(view, MAX_KIND),
      maxBytes: view.getFloat64(MAX_BYTES, true),
      heapUsedMB: Math.round(view.getFloat64(HEAP_USED, true) / 2 ** 20)
    })
  }
  return entries
}

/** The parent frees an exited worker's slot; its thread id is never reused in this process. */
export function releaseWorkerSendLedgerSlot(owner: number): void {
  const ledger = sharedLedger()
  if (!ledger) {
    return
  }
  const owners = new Int32Array(ledger)
  for (let slot = 0; slot < SLOTS; slot += 1) {
    const index = (slot * SLOT_BYTES) / 4
    if (Atomics.load(owners, index) === owner) {
      new Uint8Array(ledger, slot * SLOT_BYTES, SLOT_BYTES).fill(0)
      return
    }
  }
}
