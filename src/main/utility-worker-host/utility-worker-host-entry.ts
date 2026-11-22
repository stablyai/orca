import type { Worker } from 'node:worker_threads'
import { installFatalSignalListenerGuard } from '../crash-reporting/fatal-signal-listener-guard'
import { sampleUtilityWorkerHeaps } from './utility-worker-heap-sampler'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { setWorkerLargeSendLog } from '../worker-threads/worker-send-ledger'
import {
  UTILITY_WORKER_RELAY_EXPIRED,
  UTILITY_WORKER_RELAY_HOLD_LIMIT_MS,
  UtilityWorkerRelayBudget
} from './utility-worker-relay-budget'
import {
  UTILITY_WORKER_MESSAGE_CHUNK_BYTES,
  UTILITY_WORKER_NO_HEAP_SAMPLING_ARG,
  type UtilityWorkerFailure,
  type UtilityWorkerHostEvent,
  type UtilityWorkerHostRequest,
  type UtilityWorkerPort,
  type UtilityWorkerPortEvent,
  type UtilityWorkerPortRequest
} from './utility-worker-host-protocol'

installFatalSignalListenerGuard()

type WorkerPort = UtilityWorkerPort<UtilityWorkerPortRequest>

type UtilityParentPort = {
  on(
    event: 'message',
    listener: (event: { data: UtilityWorkerHostRequest; ports: WorkerPort[] }) => void
  ): unknown
  postMessage(message: UtilityWorkerHostEvent): void
}
// Electron types it as always set, but only a utility process has one.
const parent: UtilityParentPort | undefined = process.parentPort
if (!parent) {
  throw new Error('The worker host must run as an Electron utility process')
}

const LOADED = 'orca-hosted-worker-loaded'
const control = parent
const workers = new Map<number, Worker>()
const ports = new Map<number, WorkerPort>()
// A launcher's workers only relay child processes, so periodic heap samples would be idle wakeups.
const heaps = process.argv.includes(UTILITY_WORKER_NO_HEAP_SAMPLING_ARG)
  ? { workersChanged: () => {} }
  : sampleUtilityWorkerHeaps(workers, (report) => control.postMessage({ type: 'heap', report }))

function failure(error: unknown): UtilityWorkerFailure {
  const value = error instanceof Error ? error : new Error(String(error))
  const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined
  return { name: value.name, message: value.message, ...(code ? { code } : {}) }
}

/**
 * Runs the entry with its posts already v8-serialized and their buffers moved, not cloned, so this
 * thread forwards bytes instead of decoding and re-encoding every reply. Patched before the entry
 * loads, so its own send ledger still sees the original message.
 */
function hostedEntrySource(filename: string): string {
  return `const { parentPort } = require('node:worker_threads')
const { serialize } = require('node:v8')
const post = parentPort.postMessage.bind(parentPort)
Object.defineProperty(parentPort, 'postMessage', {
  configurable: true,
  writable: true,
  value: (message) => {
    const bytes = serialize(message)
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    post(bytes, owned ? [bytes.buffer] : [])
  }
})
require(${JSON.stringify(filename)})
post(${JSON.stringify(LOADED)})`
}

function relay(id: number, bytes: Uint8Array, seq?: number): void {
  const port = ports.get(id)
  if (!port) {
    return
  }
  for (let start = 0; start < bytes.byteLength; start += UTILITY_WORKER_MESSAGE_CHUNK_BYTES) {
    const end = Math.min(start + UTILITY_WORKER_MESSAGE_CHUNK_BYTES, bytes.byteLength)
    const view = bytes.subarray(start, end)
    // A view clones its whole backing buffer (the shared pool for small ones), so copy partial views.
    const chunk =
      view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
        ? view
        : new Uint8Array(view)
    const more = end < bytes.byteLength
    send(port, { type: 'message', bytes: chunk, more, ...(seq === undefined ? {} : { seq }) })
  }
}

const budget = new UtilityWorkerRelayBudget(relay, (id) => {
  const message = `worker reply waited ${UTILITY_WORKER_RELAY_HOLD_LIMIT_MS / 1000} s for main to consume earlier replies`
  const port = ports.get(id)
  if (port) {
    send(port, { type: 'error', error: { name: UTILITY_WORKER_RELAY_EXPIRED, message } })
  }
  void workers.get(id)?.terminate()
})

function send(port: WorkerPort, event: UtilityWorkerPortEvent): void {
  port.postMessage(event)
}

function host(
  request: Extract<UtilityWorkerHostRequest, { type: 'spawn' }>,
  port: WorkerPort
): void {
  let worker: ReturnType<typeof spawnWorkerThread>
  try {
    if (request.largeSendLog) {
      setWorkerLargeSendLog(request.largeSendLog)
    }
    worker = spawnWorkerThread(hostedEntrySource(request.filename), {
      eval: true,
      name: request.name,
      workerData: request.workerData,
      execArgv: []
    })
  } catch (error) {
    send(port, { type: 'error', error: failure(error) })
    send(port, { type: 'exit', code: 1 })
    return
  }
  const { id } = request
  ports.set(id, port)
  // Everything but replies waits behind this worker's own held replies, never another worker's.
  worker.on('message', (bytes: Uint8Array | typeof LOADED) =>
    bytes === LOADED
      ? budget.after(id, () => send(port, { type: 'loaded' }))
      : budget.offer(id, bytes)
  )
  workers.set(id, worker)
  heaps.workersChanged()
  worker.on('error', (error) =>
    budget.after(id, () => send(port, { type: 'error', error: failure(error) }))
  )
  // The consumer closes the port once it reads this, so the frame is never cut off.
  worker.once('exit', (code) => {
    workers.delete(id)
    heaps.workersChanged()
    budget.after(id, () => {
      budget.forget(id)
      ports.delete(id)
      send(port, { type: 'exit', code })
    })
  })
  port.on('message', ({ data }) => {
    if (data.type === 'post') {
      worker.postMessage(data.message)
    } else {
      void worker.terminate()
    }
  })
  // The consumer is gone (main retired it or itself died); nothing can read this worker's replies.
  port.on('close', () => {
    // After its exit the port is already gone; releasing then would mark a finished worker forever.
    if (ports.delete(id)) {
      budget.release(id)
    }
    void worker.terminate()
  })
  port.start()
}

parent.on('message', ({ data, ports: transferred }) => {
  if (data.type === 'budget') {
    budget.setLimit(data.bytes)
    return
  }
  if (data.type === 'ack') {
    budget.ack(data.seq)
    return
  }
  const port = transferred[0]
  if (port) {
    host(data, port)
  }
})
parent.postMessage({ type: 'ready' })
