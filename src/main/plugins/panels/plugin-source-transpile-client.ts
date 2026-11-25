import { existsSync } from 'node:fs'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import type { WorkerRequestTransport } from '../../worker-threads/worker-thread-transport'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type {
  PluginSourceTranspiled,
  PluginSourceTranspileRequest,
  PluginSourceTranspileWorkerMessage
} from './source-transpilation/plugin-source-transpile-protocol'

/** A file still transpiling after this is cut short: its worker is terminated and replaced. */
export const PLUGIN_SOURCE_MODULE_BUDGET_MS = 2_000
/** A new worker not ready after this is terminated, so one that never comes up still fails. */
const WORKER_BOOT_BUDGET_MS = 10_000

export type PluginSourceTranspile = (
  relativePath: string,
  source: string
) => Promise<PluginSourceTranspiled>

/** The part of a worker the client uses, so tests can inject their own thread. */
export type PluginSourceTranspileWorker = Omit<WorkerRequestTransport, 'removeAllListeners'>

const WORKER_ENTRY_FILENAME = 'plugin-source-transpile-worker-entry.js'

function defaultWorkerFactory(): PluginSourceTranspileWorker {
  const path = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKER_ENTRY_FILENAME
  )
  if (!existsSync(path)) {
    throw new Error(`plugin source transpile worker entry not found: ${path}`)
  }
  return spawnWorkerThread(path, { name: 'orca-plugin-transpile' })
}

/**
 * One lazily started worker, kept warm and shared, transpiling one file at a time. A request over
 * the budget, or a worker crash, terminates the worker; the next request starts a fresh one. The
 * budget starts once the worker reports ready, so cold start does not count against a file.
 */
export function createPluginSourceTranspileClient(
  options: { createWorker?: () => PluginSourceTranspileWorker; budgetMs?: number } = {}
): PluginSourceTranspile {
  const createWorker = options.createWorker ?? defaultWorkerFactory
  const budgetMs = options.budgetMs ?? PLUGIN_SOURCE_MODULE_BUDGET_MS
  let worker: PluginSourceTranspileWorker | null = null
  let workerReady = false
  let nextId = 0
  let queue: Promise<unknown> = Promise.resolve()

  const runOne = (request: PluginSourceTranspileRequest): Promise<PluginSourceTranspiled> =>
    new Promise((resolve) => {
      let active: PluginSourceTranspileWorker
      try {
        if (!worker) {
          worker = createWorker()
          workerReady = false
        }
        active = worker
        // Why unref: an idle warm worker must not keep the process alive at quit.
        active.unref()
      } catch (error) {
        resolve({ ok: false, message: error instanceof Error ? error.message : String(error) })
        return
      }
      const finish = (result: PluginSourceTranspiled, discardWorker: boolean): void => {
        clearTimeout(timer)
        active.off('message', onMessage)
        active.off('error', onFailure)
        active.off('exit', onFailure)
        if (discardWorker && worker === active) {
          worker = null
          void active.terminate()
        }
        resolve(result)
      }
      const failAfter = (ms: number, message: string): ReturnType<typeof setTimeout> =>
        setTimeout(() => finish({ ok: false, message, transient: true }, true), ms)
      const startBudget = (): ReturnType<typeof setTimeout> =>
        failAfter(
          budgetMs,
          `took over the ${budgetMs} ms transpile budget; split it into smaller modules`
        )
      let timer = workerReady
        ? startBudget()
        : failAfter(
            WORKER_BOOT_BUDGET_MS,
            `the transpiler did not start within ${WORKER_BOOT_BUDGET_MS} ms`
          )
      const onMessage = (message: PluginSourceTranspileWorkerMessage): void => {
        if ('ready' in message) {
          workerReady = true
          clearTimeout(timer)
          timer = startBudget()
        } else if (message.id === request.id) {
          finish(message.result, false)
        }
      }
      const onFailure = (error?: unknown): void =>
        finish(
          {
            ok: false,
            message: `the transpiler stopped: ${error instanceof Error ? error.message : String(error)}`,
            transient: true
          },
          true
        )
      active.on('message', onMessage)
      active.on('error', onFailure)
      active.on('exit', onFailure)
      active.postMessage(request)
    })

  return (relativePath, source) => {
    const request = { id: (nextId += 1), relativePath, source }
    const result = queue.then(() => runOne(request))
    queue = result
    return result
  }
}
