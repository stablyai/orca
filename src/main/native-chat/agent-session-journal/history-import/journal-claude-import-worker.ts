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
// A few imports of each kind run at once: a large first open never holds a recovery or a rewind,
// and the heavy host never takes an unbounded pile of transcript workers.
const SLOTS_PER_KIND = 3
type Slots = { active: number; waiting: (() => void)[] }
const slots: Record<'first' | 'recovery', Slots> = {
  first: { active: 0, waiting: [] },
  recovery: { active: 0, waiting: [] }
}

async function takeSlot(kind: keyof typeof slots, signal?: AbortSignal): Promise<() => void> {
  const pool = slots[kind]
  if (pool.active < SLOTS_PER_KIND) {
    pool.active += 1
  } else {
    // A released slot passes straight to the next waiter, so a newcomer can't take it first.
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        signal?.removeEventListener('abort', cancel)
        resolve()
      }
      const cancel = () => {
        pool.waiting.splice(pool.waiting.indexOf(admit), 1)
        reject(signal?.reason)
      }
      pool.waiting.push(admit)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) {
        cancel()
      }
    })
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const next = pool.waiting.shift()
    if (next) {
      next()
    } else {
      pool.active -= 1
    }
  }
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
  const release = await takeSlot(work.bounded ? 'recovery' : 'first', signal)
  try {
    // A slot can open in the same tick as an abort.
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
