import { pluginWorkerInvokeTaskSourceParamsSchema } from '../../../shared/plugins/workers/plugin-host-protocol'

export type PluginWorkerHandlerContext = { signal: AbortSignal }

/** Handlers behind one `contributes.taskSources` entry; results are validated host-side. */
export type PluginWorkerTaskSourceHandlers = {
  list(params: unknown, context: PluginWorkerHandlerContext): unknown
  get(params: unknown, context: PluginWorkerHandlerContext): unknown
}

/** `orca.tasks` as a worker's activate(orca) receives it. */
export type PluginWorkerTasksApi = {
  registerSource(sourceId: string, handlers: PluginWorkerTaskSourceHandlers): { dispose(): void }
}

type TaskSourceCall = { run: (context: PluginWorkerHandlerContext) => unknown } | { what: string }

/** The worker's registered task sources, and the handler a `taskSource.invoke` request reaches. */
export function createWorkerTaskSources() {
  const sources = new Map<string, PluginWorkerTaskSourceHandlers>()
  const api: PluginWorkerTasksApi = Object.freeze({
    registerSource(sourceId: string, handlers: PluginWorkerTaskSourceHandlers) {
      if (typeof handlers?.list !== 'function' || typeof handlers?.get !== 'function') {
        throw new Error(`task source ${sourceId} must provide list and get handlers`)
      }
      sources.set(sourceId, handlers)
      return { dispose: () => void sources.delete(sourceId) }
    }
  })
  return {
    api,
    ids: () => [...sources.keys()],
    resolve(rawParams: unknown): TaskSourceCall {
      const parsed = pluginWorkerInvokeTaskSourceParamsSchema.safeParse(rawParams)
      const handlers = parsed.success ? sources.get(parsed.data.sourceId) : undefined
      if (!parsed.success || !handlers) {
        return { what: `task source ${parsed.success ? parsed.data.sourceId : '(invalid)'}` }
      }
      const { operation, params } = parsed.data
      // Why: call through the object so plugin authors can use `this` in an object-literal source.
      return {
        run: (context) =>
          operation === 'list' ? handlers.list(params, context) : handlers.get(params, context)
      }
    }
  }
}
