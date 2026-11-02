import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-thread-entry-path'
import type {
  PluginSourceTranspiled,
  PluginSourceTranspileRequest,
  PluginSourceTranspileResponse
} from './plugin-source-transpile-protocol'

/** A file still transpiling after this is cut short: its worker is terminated and replaced. */
export const PLUGIN_SOURCE_MODULE_BUDGET_MS = 2_000

export type PluginSourceTranspile = (
  relativePath: string,
  source: string
) => Promise<PluginSourceTranspiled>

/** The part of a worker the client uses, so tests can inject their own thread. */
export type PluginSourceTranspileWorker = Pick<
  Worker,
  'postMessage' | 'on' | 'off' | 'terminate' | 'unref'
>

const WORKER_ENTRY_FILENAME = 'plugin-source-transpile-worker-entry.js'

function defaultWorkerFactory(): PluginSourceTranspileWorker {
  const path = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKER_ENTRY_FILENAME
  )
  if (!existsSync(path)) {
    throw new Error(`plugin source transpile worker entry not found: ${path}`)
  }
  return new Worker(path)
}

/**
 * One lazily started worker, kept warm and shared, transpiling one file at a time. A request over
 * the budget, or a worker crash, terminates the worker; the next request starts a fresh one.
 */
export function createPluginSourceTranspileClient(
  options: { createWorker?: () => PluginSourceTranspileWorker; budgetMs?: number } = {}
): PluginSourceTranspile {
  const createWorker = options.createWorker ?? defaultWorkerFactory
  const budgetMs = options.budgetMs ?? PLUGIN_SOURCE_MODULE_BUDGET_MS
  let worker: PluginSourceTranspileWorker | null = null
  let nextId = 0
  let queue: Promise<unknown> = Promise.resolve()

  const runOne = (request: PluginSourceTranspileRequest): Promise<PluginSourceTranspiled> =>
    new Promise((resolve) => {
      let active: PluginSourceTranspileWorker
      try {
        worker ??= createWorker()
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
      const onMessage = (response: PluginSourceTranspileResponse): void => {
        if (response.id === request.id) {
          finish(response.result, false)
        }
      }
      const onFailure = (error?: unknown): void =>
        finish(
          {
            ok: false,
            message: `the transpiler stopped: ${error instanceof Error ? error.message : String(error)}`
          },
          true
        )
      const timer = setTimeout(
        () =>
          finish(
            {
              ok: false,
              message: `took over the ${budgetMs} ms transpile budget; split it into smaller modules`
            },
            true
          ),
        budgetMs
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
