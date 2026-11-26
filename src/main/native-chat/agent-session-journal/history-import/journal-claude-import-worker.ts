import { assertAdoptedSourceIdentity } from './adopted-transcript-source'
import type { ClaudeSourceVersion } from './journal-claude-import-source-version'
import { AgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  retryHeavyWorkers,
  spawnHeavyWorker
} from '../../../utility-worker-host/heavy-worker-spawn'
import { UtilityWorkerHostPausedError } from '../../../utility-worker-host/utility-worker-host-protocol'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import {
  ClaudeImportGrowthError,
  ClaudeImportResourceError
} from './journal-claude-import-resource-error'
import type {
  ClaudeImportHeader,
  ClaudeImportWork,
  ClaudeImportWorkerRequest,
  ClaudeImportWorkerResponse
} from './journal-claude-import-worker-protocol'

type Slots = { limit: number; active: number; waiting: (() => void)[] }
// Two preparations cap attached index buffers at 384 MiB. RSS also includes runtime, decoding and allocator retention.
const importSlots: Slots = { limit: 2, active: 0, waiting: [] }
// Reserve the verifier before starting work so completed preparation never waits with an import slot.
const verifierSlots: Slots = { limit: 4, active: 0, waiting: [] }
const pageSlots: Slots = { limit: 2, active: 0, waiting: [] }
let reportedHostPause = false

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

export type ClaudeImportWorker = Omit<ClaudeImportHeader, 'identity'> & {
  verify(): Promise<ClaudeSourceVersion>
  close(): Promise<void>
}

/** One page credit stays held until the receiving writer has acknowledged it. */
export async function importClaudeTranscriptInWorker(
  input: ClaudeImportWork & { signal?: AbortSignal },
  acceptPage: (bytes: Uint8Array, ordinal: number, header: ClaudeImportHeader) => Promise<void>
): Promise<ClaudeImportWorker> {
  const { signal, ...work } = input
  // Only a new request after a pause refusal can retry the host.
  const retryHost = reportedHostPause
  const releaseVerifier = await takeSlot(verifierSlots, signal)
  let releaseImport: (() => void) | undefined
  let worker: ReturnType<typeof spawnHeavyWorker>
  try {
    releaseImport = await takeSlot(importSlots, signal)
    signal?.throwIfAborted()
    if (retryHost && reportedHostPause) {
      reportedHostPause = false
      retryHeavyWorkers()
    }
    const entry = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-claude-import-worker-entry.js'
    )
    worker = spawnHeavyWorker(entry, {
      name: 'orca-claude-history-import',
      workerData: work
    })
  } catch (error) {
    releaseImport?.()
    releaseVerifier()
    if (error instanceof UtilityWorkerHostPausedError) {
      reportedHostPause = true
    }
    signal?.throwIfAborted()
    throw new ClaudeImportResourceError('Claude history import worker is unavailable.', {
      cause: error
    })
  }
  const lifetime = new AbortController()
  const first = Promise.withResolvers<ClaudeImportWorkerResponse>()
  let pending: typeof first | undefined = first
  let closing: Promise<void> | undefined
  const stop = (error: unknown) => {
    lifetime.abort(error)
    pending?.reject(error)
    pending = undefined
  }
  const onMessage = (response: ClaudeImportWorkerResponse, release?: () => void) => {
    pending?.resolve(response)
    pending = undefined
    release?.()
  }
  const onError = (error: Error) =>
    stop(new ClaudeImportResourceError(error.message, { cause: error }))
  const onExit = (code: number) =>
    stop(new ClaudeImportResourceError(`Claude history import worker exited (${code}).`))
  const abort = () => stop(signal?.reason)
  const check = () => {
    signal?.throwIfAborted()
    lifetime.signal.throwIfAborted()
  }
  worker.on('message', onMessage)
  worker.on('error', onError)
  worker.once('exit', onExit)
  signal?.addEventListener('abort', abort, { once: true })

  async function request(message: ClaudeImportWorkerRequest): Promise<ClaudeImportWorkerResponse> {
    if (pending) {
      throw new Error('Claude history import worker already has a pending request.')
    }
    const reply = Promise.withResolvers<ClaudeImportWorkerResponse>()
    pending = reply
    try {
      worker.postMessage(message)
    } catch (error) {
      stop(
        new ClaudeImportResourceError('Claude history import worker stopped receiving.', {
          cause: error
        })
      )
    }
    return reply.promise
  }

  function close(): Promise<void> {
    return (closing ??= (async () => {
      try {
        if (!lifetime.signal.aborted && !pending) {
          await request({ kind: 'close' }).catch(() => undefined)
        }
        await worker.terminate()
      } finally {
        signal?.removeEventListener('abort', abort)
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
        releaseImport?.()
        releaseVerifier()
      }
    })())
  }

  try {
    if (signal?.aborted) {
      abort()
    }
    const response = await first.promise
    check()
    if (response.kind !== 'imported') {
      failImport(response)
    }
    const { header } = response
    if (work.source && !header.sourceEmpty) {
      if (!header.identity) {
        throw new ClaudeImportResourceError('Claude history source identity is unavailable.')
      }
      await assertAdoptedSourceIdentity(
        work.source,
        header.identity,
        true,
        lifetime.signal,
        work.agent
      )
      check()
    }
    const verify = async () => {
      check()
      const result = await request({ kind: 'verify' })
      check()
      if (result.kind !== 'verified') {
        failImport(result)
      }
      return result.version
    }
    await verify()
    for (let ordinal = 0; header.count > 0; ordinal++) {
      const releasePage = await takeSlot(pageSlots, lifetime.signal)
      try {
        check()
        const page = await request({ kind: 'pull' })
        check()
        if (page.kind === 'finished') {
          break
        }
        if (page.kind !== 'page') {
          failImport(page)
        }
        await acceptPage(page.bytes, ordinal, header)
      } finally {
        try {
          if (lifetime.signal.aborted) {
            await close()
          }
        } finally {
          releasePage()
        }
      }
    }
    releaseImport()
    return { count: header.count, sourceEmpty: header.sourceEmpty, verify, close }
  } catch (error) {
    await close()
    throw error
  }
}

function failImport(response: ClaudeImportWorkerResponse): never {
  switch (response.kind) {
    case 'growth':
      throw new ClaudeImportGrowthError(response.growth)
    case 'resource':
    case 'failed':
      throw new ClaudeImportResourceError(response.message)
    case 'refusal':
      throw new AgentSessionRefusalError(response.refusal)
    case 'imported':
    case 'page':
    case 'finished':
    case 'verified':
    case 'closed':
      throw new ClaudeImportResourceError('Unexpected Claude history import response.')
  }
}
