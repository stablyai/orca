import { AgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { spawnHeavyWorker } from '../../../utility-worker-host/heavy-worker-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import {
  collectClaudeImportWindow,
  type ClaudeImportResult,
  type ClaudeImportRestore
} from './journal-claude-import-window'
import {
  CLAUDE_RECOVERY_CONCURRENCY,
  type ClaudeImportPage,
  type ClaudeImportWork,
  type ClaudeImportWorkerRequest,
  type ClaudeImportWorkerResponse
} from './journal-claude-import-worker-protocol'

let entryOverride: string | undefined
// A few imports of each kind run at once: a large first open never holds a recovery or a rewind,
// and the heavy host never takes an unbounded pile of transcript workers.
type Slots = { limit: number; active: number; waiting: (() => void)[] }
const slots = {
  first: { limit: 3, active: 0, waiting: [] },
  recovery: { limit: CLAUDE_RECOVERY_CONCURRENCY, active: 0, waiting: [] },
  page: { limit: 2, active: 0, waiting: [] }
} satisfies Record<string, Slots>

async function takeSlot(pool: Slots, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted()
  if (pool.active < pool.limit) {
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
  input: ClaudeImportWork & { signal?: AbortSignal },
  restore?: ClaudeImportRestore
): Promise<ClaudeImportResult> {
  const { signal, ...work } = input
  const release = await takeSlot(slots[work.bounded ? 'recovery' : 'first'], signal)
  try {
    // A slot can open in the same tick as an abort.
    signal?.throwIfAborted()
    return await runImportWorker(work, signal, restore)
  } finally {
    release()
  }
}

async function runImportWorker(
  work: ClaudeImportWork,
  signal: AbortSignal | undefined,
  restore: ClaudeImportRestore | undefined
): Promise<ClaudeImportResult> {
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
  const lifetime = new AbortController()
  let terminated: Promise<number> | undefined
  const terminate = () => (terminated ??= worker.terminate())
  const first = Promise.withResolvers<ClaudeImportWorkerResponse>()
  let pending: typeof first | undefined = first
  let scanning = true
  const stop = (error: unknown) => {
    lifetime.abort(error)
    pending?.reject(error)
    pending = undefined
  }
  const post = (request: ClaudeImportWorkerRequest) => {
    try {
      worker.postMessage(request)
    } catch (error) {
      stop(
        new ClaudeImportResourceError('Claude history import worker stopped receiving.', {
          cause: error
        })
      )
    }
  }
  const onMessage = (response: ClaudeImportWorkerResponse, release?: () => void) => {
    try {
      pending?.resolve(response)
      pending = undefined
    } finally {
      release?.()
    }
  }
  const onError = (error: Error) =>
    stop(new ClaudeImportResourceError(error.message, { cause: error }))
  const onExit = (code: number) =>
    stop(new ClaudeImportResourceError(`Claude history import worker exited (${code}).`))
  const abort = () => {
    if (scanning) {
      // The scan closes its scratch before replying to a cooperative abort.
      post({ kind: 'abort' })
    } else {
      stop(signal?.reason)
    }
  }
  const check = () => {
    signal?.throwIfAborted()
    lifetime.signal.throwIfAborted()
  }
  worker.on('message', onMessage)
  worker.on('error', onError)
  worker.once('exit', onExit)
  signal?.addEventListener('abort', abort, { once: true })

  async function pull(): Promise<ClaudeImportPage> {
    const release = await takeSlot(slots.page, lifetime.signal)
    try {
      check()
      const reply = Promise.withResolvers<ClaudeImportWorkerResponse>()
      pending = reply
      post({ kind: 'pull' })
      const response = await reply.promise
      if (response.kind !== 'page') {
        failImport(response, signal)
      }
      return response
    } finally {
      try {
        // A late reply can still be in flight after cancellation rejects the pending pull.
        if (lifetime.signal.aborted) {
          await terminate()
        }
      } finally {
        release()
      }
    }
  }

  try {
    if (signal?.aborted) {
      abort()
    }
    const response = await first.promise
    scanning = false
    check()
    if (response.kind !== 'imported') {
      failImport(response, signal)
    }
    return await collectClaudeImportWindow(response.header, pull, check, lifetime.signal, restore)
  } finally {
    signal?.removeEventListener('abort', abort)
    try {
      await terminate()
    } finally {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
  }
}

function failImport(response: ClaudeImportWorkerResponse, signal?: AbortSignal): never {
  switch (response.kind) {
    case 'resource':
      throw new ClaudeImportResourceError(response.message)
    case 'refusal':
      throw new AgentSessionRefusalError(response.refusal)
    case 'aborted':
      signal?.throwIfAborted()
      throw new Error('Claude history import was cancelled.')
    case 'failed':
      throw new Error(response.message)
    case 'imported':
    case 'page':
      throw new ClaudeImportResourceError('Unexpected Claude history import response.')
  }
}
