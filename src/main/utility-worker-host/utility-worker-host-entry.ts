import type { Worker } from 'node:worker_threads'
import { installFatalSignalListenerGuard } from '../crash-reporting/fatal-signal-listener-guard'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { setWorkerLargeSendLog } from '../worker-threads/worker-send-ledger'
import {
  UTILITY_WORKER_MESSAGE_CHUNK_BYTES,
  type UtilityWorkerFailure,
  type UtilityWorkerHostEvent,
  type UtilityWorkerHostRequest
} from './utility-worker-host-protocol'

installFatalSignalListenerGuard()

type UtilityParentPort = {
  on(event: 'message', listener: (event: { data: UtilityWorkerHostRequest }) => void): unknown
  postMessage(message: UtilityWorkerHostEvent): void
}
// Electron types it as always set, but only a utility process has one.
const parent: UtilityParentPort | undefined = process.parentPort
if (!parent) {
  throw new Error('The worker host must run as an Electron utility process')
}
const port = parent
const workers = new Map<number, Worker>()

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
require(${JSON.stringify(filename)})`
}

function relay(id: number, bytes: Uint8Array): void {
  for (let start = 0; start < bytes.byteLength; start += UTILITY_WORKER_MESSAGE_CHUNK_BYTES) {
    const end = Math.min(start + UTILITY_WORKER_MESSAGE_CHUNK_BYTES, bytes.byteLength)
    const view = bytes.subarray(start, end)
    // A view clones its whole backing buffer (the shared pool for small ones), so copy partial views.
    const chunk =
      view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
        ? view
        : new Uint8Array(view)
    port.postMessage({ type: 'message', id, bytes: chunk, more: end < bytes.byteLength })
  }
}

port.on('message', ({ data: request }) => {
  if (request.type === 'spawn') {
    const { id } = request
    try {
      if (request.largeSendLog) {
        setWorkerLargeSendLog(request.largeSendLog)
      }
      const worker = spawnWorkerThread(hostedEntrySource(request.filename), {
        eval: true,
        name: request.name,
        workerData: request.workerData,
        execArgv: []
      })
      workers.set(id, worker)
      worker.on('message', (bytes: Uint8Array) => relay(id, bytes))
      worker.on('error', (error) => port.postMessage({ type: 'error', id, error: failure(error) }))
      worker.once('exit', (code) => {
        workers.delete(id)
        port.postMessage({ type: 'exit', id, code })
      })
    } catch (error) {
      port.postMessage({ type: 'error', id, error: failure(error) })
      port.postMessage({ type: 'exit', id, code: 1 })
    }
    return
  }
  const worker = workers.get(request.id)
  if (request.type === 'post') {
    worker?.postMessage(request.message)
  } else {
    void worker?.terminate()
  }
})
port.postMessage({ type: 'ready' })
