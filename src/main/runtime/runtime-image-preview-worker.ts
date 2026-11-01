import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'

const FILENAME = 'runtime-image-preview-worker-entry.js'
let activeWorkers = 0

function workerEntry(): string {
  const entry = resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), FILENAME)
  return [entry, join(dirname(entry), '..', FILENAME)].find(existsSync) ?? entry
}

export async function shrinkImagePreviewInWorker(
  bytes: Buffer,
  maxBytes: number,
  path = workerEntry(),
  timeoutMs = 15_000
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (activeWorkers >= 2) throw new Error('Image preview workers are busy')
  activeWorkers++
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path, {
        workerData: { bytes, maxBytes },
        resourceLimits: { maxOldGenerationSizeMb: 256 }
      })
      let result: { bytes: Buffer; mimeType: string } | undefined
      let failure: Error | undefined
      const timer = setTimeout(() => {
        failure = new Error('Image preview timed out')
        void worker.terminate()
      }, timeoutMs)
      worker.once('message', (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'bytes' in message &&
          message.bytes instanceof Uint8Array &&
          message.bytes.length <= maxBytes &&
          'mimeType' in message &&
          (message.mimeType === 'image/png' || message.mimeType === 'image/jpeg')
        ) {
          result = { bytes: Buffer.from(message.bytes), mimeType: message.mimeType }
        } else {
          failure = new Error('Invalid image preview worker response')
          void worker.terminate()
        }
      })
      worker.once('error', (error) => {
        failure = error instanceof Error ? error : new Error(String(error))
      })
      worker.once('exit', (code) => {
        clearTimeout(timer)
        if (!failure && code === 0 && result) resolve(result)
        else reject(failure ?? new Error(`Image preview worker exited (${code})`))
      })
    })
  } finally {
    activeWorkers--
  }
}
