import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { AdoptedTranscriptObservation } from './adopted-transcript-observation'
import type {
  LegacyImportWorkerMessage,
  LegacyTranscriptImportRequest,
  PreparedLegacyImport
} from './journal-legacy-import-worker-protocol'

export type LegacyImportWorker = Pick<
  Worker,
  'on' | 'once' | 'unref' | 'postMessage' | 'terminate' | 'removeAllListeners'
>

function startWorker(request: LegacyTranscriptImportRequest): LegacyImportWorker {
  return spawnWorkerThread(
    resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-legacy-import-worker-entry.js'
    ),
    { workerData: request }
  )
}

/** Only the owning host validates directories or publishes the prepared history. */
export function runLegacyTranscriptImportWorker(
  request: LegacyTranscriptImportRequest,
  validate: (observed: AdoptedTranscriptObservation, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
  factory = startWorker
): Promise<PreparedLegacyImport> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    let worker: LegacyImportWorker
    try {
      worker = factory(request)
    } catch (error) {
      reject(error)
      return
    }
    worker.unref()
    const validationAbort = new AbortController()
    let failure: unknown
    let result: PreparedLegacyImport | undefined
    let validation: Promise<void> | undefined
    let validationRequested = false
    let validationCompleted = false
    const stop = (error: unknown) => {
      failure ??= error ?? new Error('History import cancelled')
      validationAbort.abort(failure)
      void worker.terminate().catch((error: unknown) => {
        failure ??= error
      })
    }
    const abort = () => stop(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    // The signal may have changed while the worker factory was starting.
    if (signal?.aborted) {
      abort()
    }
    worker.on('message', (message: LegacyImportWorkerMessage) => {
      if (failure) {
        return
      }
      if (message?.type === 'validate-source') {
        if (
          !request.validateSource ||
          validationRequested ||
          result ||
          !message.observed ||
          !(
            message.observed.sessionId === null || typeof message.observed.sessionId === 'string'
          ) ||
          !(message.observed.cwd === null || typeof message.observed.cwd === 'string')
        ) {
          stop(new Error('Invalid history validation response'))
          return
        }
        validationRequested = true
        validation = Promise.resolve()
          .then(() => validate(message.observed, validationAbort.signal))
          .then(
            () => {
              validationCompleted = true
              if (!failure) {
                worker.postMessage({ ok: true })
              }
            },
            (error: unknown) => {
              if (!failure) {
                worker.postMessage({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error)
                })
              }
            }
          )
          .catch(stop)
      } else if (
        message?.type === 'result' &&
        !result &&
        message.result &&
        ((message.result.ok === false && typeof message.result.error === 'string') ||
          (message.result.ok === true &&
            Array.isArray(message.result.items) &&
            typeof message.result.sourceEmpty === 'boolean'))
      ) {
        result = message.result
      } else {
        stop(new Error('Invalid history import response'))
      }
    })
    worker.once('messageerror', stop)
    worker.once('error', (error) => {
      failure ??= error
      validationAbort.abort(failure)
    })
    worker.once('exit', (code) => {
      if (
        code !== 0 ||
        !result ||
        (result.ok && request.validateSource && !result.sourceEmpty && !validationCompleted)
      ) {
        failure ??= new Error('History import ended before completion')
      }
      // An unexpected exit during validation must also cancel the host-owned probe.
      validationAbort.abort(failure)
      void Promise.resolve(validation).finally(() => {
        signal?.removeEventListener('abort', abort)
        worker.removeAllListeners()
        if (failure) {
          reject(failure)
        } else if (result) {
          resolve(result)
        }
      })
    })
  })
}
