import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'
import type { CodexRolloutHistoryReferences } from './codex-rollout-history-references'
import type {
  CodexRolloutReferencesRequest,
  CodexRolloutReferencesResponse,
  CodexRolloutReferencesWorkerData
} from './codex-rollout-history-references-protocol'

const WORKER_FILENAME = 'codex-rollout-history-references-worker-entry.js'

export function codexRolloutHistoryCachePath(): string {
  return join(getOrcaUserDataPath(), 'codex-rollout-history-bases.json')
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type Call = Exclude<CodexRolloutReferencesRequest, { op: 'abort' }>
type CallBody = Call extends infer C ? (C extends Call ? Omit<C, 'id'> : never) : never

/**
 * The sweep's fork index, run in its own worker thread: listing and diffing archive-sized folders
 * before every deletion would otherwise hold Electron main. A worker that fails or exits rejects
 * every call, so no rollout is proven unreferenced. `close` ends the worker once the sweep is done.
 */
export function createCodexRolloutHistoryReferencesClient(
  signal: AbortSignal,
  createWorker: (data: CodexRolloutReferencesWorkerData) => Worker = (data) =>
    spawnWorkerThread(
      resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME),
      { name: 'orca-codex-rollout-references', workerData: data }
    )
): CodexRolloutHistoryReferences & { close(): Promise<void> } {
  const pending = new Map<number, Pending>()
  let nextId = 0
  let worker: Worker | null = null
  let failure: Error | null = null

  const fail = (error: Error): void => {
    failure ??= error
    for (const call of pending.values()) {
      call.reject(failure)
    }
    pending.clear()
  }

  const start = (): Worker => {
    const started = createWorker({ cachePath: codexRolloutHistoryCachePath() })
    started.on('message', (response: CodexRolloutReferencesResponse) => {
      const call = pending.get(response.id)
      pending.delete(response.id)
      if (!call) {
        return
      }
      if (response.ok) {
        call.resolve(response.value)
      } else {
        call.reject(Object.assign(new Error(response.message), { name: response.name }))
      }
    })
    started.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
    started.on('exit', (code) =>
      fail(new Error(`Codex rollout references worker exited (${code})`))
    )
    return started
  }

  const onAbort = (): void => worker?.postMessage({ op: 'abort' })
  signal.addEventListener('abort', onAbort, { once: true })

  const call = (body: CallBody): Promise<unknown> => {
    if (failure) {
      return Promise.reject(failure)
    }
    try {
      // A cancelled sweep still saves what it read.
      if (body.op !== 'save') {
        signal.throwIfAborted()
      }
      worker ??= start()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = (nextId += 1)
    const active = worker
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      active.postMessage({ ...body, id })
    })
  }

  return {
    prepare: async (homes) => (await call({ op: 'prepare', homes })) === true,
    refresh: async (homes) => (await call({ op: 'refresh', homes })) === true,
    // Anything but a plain false skips the candidate: it is kept either way.
    refreshBlocked: async (homes) => (await call({ op: 'refreshBlocked', homes })) !== false,
    // Anything but a plain false keeps the rollout.
    isReferenced: async (rolloutId) => (await call({ op: 'isReferenced', rolloutId })) !== false,
    forget: async (rolloutId, paths) => {
      const freed = await call({ op: 'forget', rolloutId, paths })
      return typeof freed === 'string' ? freed : null
    },
    save: async () => {
      if (worker && !failure) {
        await call({ op: 'save' }).catch((error: unknown) => {
          console.warn('[workspace-cleanup] Could not save the Codex fork scan:', error)
        })
      }
    },
    close: async () => {
      signal.removeEventListener('abort', onAbort)
      const active = worker
      worker = null
      failure ??= new Error('Codex rollout references closed')
      await active?.terminate()
    }
  }
}
