// A PDF's text, read by a worker thread so the host's main thread stays free.
import { existsSync } from 'node:fs'
import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { WorkerThreadRequestQueue } from '../worker-threads/worker-thread-request-queue'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import type { PdfTextWorkerRequest, PdfTextWorkerResponse } from './google-pdf-text-worker-protocol'

const WORKER_FILENAME = 'google-pdf-text-worker-entry.js'
const WORKER_TIMEOUT_MS = 2 * 60_000
const IDLE_TEARDOWN_MS = 60_000

function createWorker(): Worker {
  const path = resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME)
  if (!existsSync(path)) {
    throw new Error(`PDF text worker entry not found: ${path}`)
  }
  return spawnWorkerThread(path, { name: 'orca-google-pdf-text' })
}

let queue: WorkerThreadRequestQueue<PdfTextWorkerRequest, PdfTextWorkerResponse> | null = null

export async function pdfTextViaWorker(data: Uint8Array): Promise<{ text: string; pages: number }> {
  queue ??= new WorkerThreadRequestQueue({
    factory: createWorker,
    idleTeardownMs: IDLE_TEARDOWN_MS,
    maxConsecutiveDeaths: 3,
    createUnavailableError: (message) => new Error(`PDF reader unavailable: ${message}`),
    describeTimeout: (timeoutMs) => `PDF reading timed out after ${timeoutMs / 1000}s`,
    describeExit: (code) => `PDF reader exited with code ${code}`,
    describeCrashLoop: (error) => `PDF reader crashed repeatedly: ${error}`,
    onUnavailable: (error) => console.warn('[google] PDF text worker unavailable:', error)
  })
  const response = await queue.dispatch((id) => ({ id, data }), WORKER_TIMEOUT_MS)
  if (!response.ok) {
    throw new Error(response.error)
  }
  return { text: response.text, pages: response.pages }
}
