import { getHeapStatistics } from 'node:v8'
import {
  getEnvironmentData,
  isMainThread,
  parentPort,
  setEnvironmentData,
  threadId,
  threadName
} from 'node:worker_threads'
import { appendWorkerLargeSend } from './worker-large-send-log'
import {
  describeWorkerMessage,
  isLargeWorkerMessage,
  type WorkerMessageShape
} from './worker-message-shape'
import type { WorkerThreadRole } from './worker-thread-roles'

/**
 * Each worker writes what it last posted to its parent into shared memory before posting, so the
 * main thread's diagnostics and the hang watchdog can name a sender even when the main thread is
 * stuck receiving that message. Fixed size: SLOTS workers, no allocation per send.
 */
const LEDGER_KEY = 'orca.worker-send-ledger.v1'
const LARGE_SEND_LOG_KEY = 'orca.worker-large-send-log.v1'
const SLOTS = 48
const SLOT_BYTES = 184
const TEXT_BYTES = 40
const OWNER = 0
const LAST_DEPTH = 4
const SENDS = 8
const LAST_AT = 16
const LAST_BYTES = 24
const LAST_ITEMS = 32
const MAX_BYTES = 40
const HEAP_USED = 48
const LAST_TRUNCATED = 56
const ROLE = 64
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

function ownerIndex(slot: number): number {
  return (slot * SLOT_BYTES + OWNER) / 4
}

/** Main thread, before spawning: workers created afterwards inherit the ledger. */
export function ensureWorkerSendLedger(): void {
  if (isMainThread && !sharedLedger()) {
    setEnvironmentData(LEDGER_KEY, new SharedArrayBuffer(SLOTS * SLOT_BYTES))
  }
}

/** Main thread: where workers append sends large enough to take down the receiver. */
export function setWorkerLargeSendLog(path: string): void {
  if (isMainThread) {
    setEnvironmentData(LARGE_SEND_LOG_KEY, path)
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

/** A full ledger records nothing more rather than share or steal a slot. */
function claimSlot(ledger: SharedArrayBuffer, owner: number): number | undefined {
  const owners = new Int32Array(ledger)
  for (let slot = 0; slot < SLOTS; slot += 1) {
    if (Atomics.compareExchange(owners, ownerIndex(slot), 0, owner) === 0) {
      return slot
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
  if (slot === undefined) {
    return
  }
  const view = new DataView(ledger, slot * SLOT_BYTES, SLOT_BYTES)
  const sender = spawnedRole(role)
  writeText(view, ROLE, sender)
  const largeSendLog = getEnvironmentData(LARGE_SEND_LOG_KEY)
  const post = port.postMessage
  Object.defineProperty(port, 'postMessage', {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof post>): void => {
      try {
        const shape = describeWorkerMessage(args[0])
        recordSend(view, shape)
        if (typeof largeSendLog === 'string' && isLargeWorkerMessage(shape)) {
          logLargeSend(largeSendLog, sender, shape)
        }
      } catch {
        // Diagnostics only.
      }
      post.call(port, ...args)
    }
  })
}

/** A shared entry (the foreign SQLite reader) serves several roles; the spawn's own name is exact. */
function spawnedRole(entryRole: WorkerThreadRole): string {
  return typeof threadName === 'string' && threadName.startsWith('orca') ? threadName : entryRole
}

function recordSend(view: DataView, shape: WorkerMessageShape): void {
  view.setFloat64(SENDS, view.getFloat64(SENDS, true) + 1, true)
  view.setFloat64(LAST_AT, Date.now(), true)
  view.setFloat64(LAST_BYTES, shape.bytes, true)
  view.setFloat64(LAST_ITEMS, shape.items, true)
  view.setInt32(LAST_DEPTH, shape.depth, true)
  view.setInt32(LAST_TRUNCATED, shape.truncated ? 1 : 0, true)
  writeText(view, LAST_KIND, shape.kind)
  if (shape.bytes > view.getFloat64(MAX_BYTES, true)) {
    view.setFloat64(MAX_BYTES, shape.bytes, true)
    writeText(view, MAX_KIND, shape.kind)
  }
  view.setFloat64(HEAP_USED, getHeapStatistics().used_heap_size, true)
}

function logLargeSend(path: string, role: string, shape: WorkerMessageShape): void {
  appendWorkerLargeSend(path, {
    at: new Date().toISOString(),
    pid: process.pid,
    role,
    threadId,
    ...shape,
    heapUsedMB: Math.round(getHeapStatistics().used_heap_size / 2 ** 20)
  })
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
    const owner = Atomics.load(owners, ownerIndex(slot))
    if (owner === 0) {
      continue
    }
    const view = new DataView(ledger, slot * SLOT_BYTES, SLOT_BYTES)
    entries.push({
      role: readText(view, ROLE),
      threadId: owner,
      sends: view.getFloat64(SENDS, true),
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

/**
 * The parent frees an exited worker's slot; thread ids are never reused in a process. A worker
 * whose parent was killed first keeps its slot until the process ends (only nested workers).
 */
export function releaseWorkerSendLedgerSlot(owner: number): void {
  const ledger = sharedLedger()
  if (!ledger) {
    return
  }
  const owners = new Int32Array(ledger)
  for (let slot = 0; slot < SLOTS; slot += 1) {
    if (Atomics.load(owners, ownerIndex(slot)) === owner) {
      // Clear while still owned, then publish the slot as free.
      new Uint8Array(ledger, slot * SLOT_BYTES + 4, SLOT_BYTES - 4).fill(0)
      Atomics.compareExchange(owners, ownerIndex(slot), owner, 0)
      return
    }
  }
}
