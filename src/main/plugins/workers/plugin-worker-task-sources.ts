import {
  pluginWorkerInvokeTaskSourceParamsSchema,
  WORKER_METHODS
} from '../../../shared/plugins/workers/plugin-host-protocol'
import type { PluginWorkerOrcaApi as SharedPluginWorkerOrcaApi } from '../../../shared/plugins/workers/plugin-worker-orca-api'
import {
  pluginError,
  pluginFailure,
  pluginResult,
  type PluginEnvelope,
  type PluginRequest
} from '../../../shared/plugins/frames/plugin-protocol'

export type { PluginDisposable } from '../../../shared/plugins/workers/plugin-worker-orca-api'

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
    /** The worker's `ready` payload: its commands and the task sources it registered. */
    ready: (commands: string[]) => ({ commands, taskSources: [...sources.keys()] }),
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

/** API surface handed to a plugin's `activate(orca)` export, with `orca.tasks`. */
export type PluginWorkerOrcaApi = SharedPluginWorkerOrcaApi & { tasks: PluginWorkerTasksApi }

export function withWorkerTaskSources(
  api: SharedPluginWorkerOrcaApi,
  sources: ReturnType<typeof createWorkerTaskSources>
): PluginWorkerOrcaApi {
  return Object.freeze({ ...api, tasks: sources.api })
}

/** Answers a `taskSource.invoke` request (false for any other); a host `cancel` aborts it through `running`. */
export async function answerWorkerTaskSourceRequest(
  sources: ReturnType<typeof createWorkerTaskSources>,
  request: PluginRequest,
  send: (message: PluginEnvelope) => void,
  running: Map<number, AbortController>
): Promise<boolean> {
  if (request.method !== WORKER_METHODS.invokeTaskSource) {
    return false
  }
  const call = sources.resolve(request.params)
  if (!('run' in call)) {
    send(
      pluginFailure(
        request.id,
        pluginError('unknown_method', `no handler registered for ${call.what}`)
      )
    )
    return true
  }
  const controller = new AbortController()
  running.set(request.id, controller)
  try {
    send(pluginResult(request.id, await call.run({ signal: controller.signal })))
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    send(pluginFailure(request.id, pluginError('action_failed', message)))
  } finally {
    running.delete(request.id)
  }
  return true
}
