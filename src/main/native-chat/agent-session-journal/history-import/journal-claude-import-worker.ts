import { AgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { spawnHeavyWorker } from '../../../utility-worker-host/heavy-worker-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import type {
  ClaudeImportWork,
  ClaudeImportWorkerRequest,
  ClaudeImportWorkerResponse
} from './journal-claude-import-worker-protocol'

type ImportResult = Extract<ClaudeImportWorkerResponse, { kind: 'imported' }>['result']

let entryOverride: string | undefined
// First opens and recoveries queue apart, so a large first open never holds a recovery's sends.
const queues = { first: Promise.resolve(), recovery: Promise.resolve() }

/** One importer of each kind per host keeps the heavy host from piling up. */
async function takeTurn(
  kind: keyof typeof queues,
  signal: AbortSignal | undefined
): Promise<() => void> {
  const previous = queues[kind]
  let release = () => {}
  queues[kind] = new Promise<void>((resolve) => {
    release = resolve
  })
  if (!signal) {
    await previous
    return release
  }
  let onAbort = () => {}
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
        }
      })
    ])
  } catch (error) {
    // Later imports still wait for the one ahead of this cancelled turn.
    void previous.then(release)
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return release
}

/** Tests bundle the entry themselves; the app builds it beside the main entry. */
export function setClaudeImportWorkerEntry(path: string | undefined): void {
  entryOverride = path
}

// A missing entry fails the spawn, which degrades like any unavailable worker.
export function claudeImportWorkerEntry(): string {
  return (
    entryOverride ??
    resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-claude-import-worker-entry.js'
    )
  )
}

/** One import per worker; a crash, OOM or paused host degrades like a full scratch disk. */
export async function importClaudeTranscriptInWorker(
  input: ClaudeImportWork & { signal?: AbortSignal }
): Promise<ImportResult> {
  const { signal, ...work } = input
  signal?.throwIfAborted()
  const release = await takeTurn(work.bounded ? 'recovery' : 'first', signal)
  try {
    // The turn ahead can settle in the same tick as an abort.
    signal?.throwIfAborted()
    return await runImportWorker(work, signal)
  } finally {
    release()
  }
}

async function runImportWorker(
  work: ClaudeImportWork,
  signal: AbortSignal | undefined
): Promise<ImportResult> {
  let worker: ReturnType<typeof spawnHeavyWorker>
  try {
    worker = spawnHeavyWorker(claudeImportWorkerEntry(), {
      name: 'orca-claude-history-import',
      workerData: work
    })
  } catch (error) {
    throw new ClaudeImportResourceError('Claude history import worker is unavailable.', {
      cause: error
    })
  }
  const abort = () => {
    const request: ClaudeImportWorkerRequest = { kind: 'abort' }
    worker.postMessage(request)
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    abort()
  }
  try {
    const response = await new Promise<ClaudeImportWorkerResponse>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', (error: Error) =>
        reject(new ClaudeImportResourceError(error.message, { cause: error }))
      )
      worker.once('exit', (code: number) =>
        reject(new ClaudeImportResourceError(`Claude history import worker exited (${code}).`))
      )
    })
    switch (response.kind) {
      case 'imported':
        return response.result
      case 'resource':
        throw new ClaudeImportResourceError(response.message)
      case 'refusal':
        throw new AgentSessionRefusalError(response.refusal)
      case 'aborted':
        signal?.throwIfAborted()
        throw new Error('Claude history import was cancelled.')
      case 'failed':
        throw new Error(response.message)
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    // The worker removes its scratch before it answers; terminating after the answer is safe.
    await worker.terminate()
  }
}
