import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  pluginWorkerDeliverParamsSchema,
  pluginWorkerInitSchema,
  pluginWorkerInvokeParamsSchema,
  pluginWorkerFatal,
  pluginWorkerLog,
  WORKER_EVENTS,
  WORKER_METHODS,
  type PluginWorkerInit
} from '../../../shared/plugins/workers/plugin-host-protocol'
import {
  pluginCancel,
  pluginError,
  pluginEvent,
  pluginFailure,
  pluginRequest,
  pluginResult,
  normalizePluginErrorCode,
  readPluginEnvelope,
  type PluginEnvelope,
  type PluginErrorCode,
  type PluginRequest,
  type PluginResponse
} from '../../../shared/plugins/frames/plugin-protocol'
import {
  pluginDataChangedSchema,
  pluginWorkerPanelRequestParamsSchema
} from '../../../shared/plugins/workers/plugin-panel-bridge-protocol'
import {
  createPluginWorkerApiTables,
  createPluginWorkerOrcaApi,
  type PluginWorkerOrcaApi
} from '../../../shared/plugins/workers/plugin-worker-orca-api'

export type {
  PluginDisposable,
  PluginWorkerOrcaApi
} from '../../../shared/plugins/workers/plugin-worker-orca-api'

export type PluginHostCallError = Error & {
  code: PluginErrorCode
  retryable: boolean
  retryAfterMs?: number
}

export type PluginWorkerRuntimeOptions = {
  send: (message: PluginEnvelope) => void
  importModule?: (specifier: string) => Promise<unknown>
  /** Runs before the entry imports; the host installs its TypeScript hooks here. */
  prepareModuleLoading?: (pluginRoot: string) => void
  exit?: (code: number) => void
}

export type PluginWorkerRuntime = {
  handleMessage(raw: unknown): Promise<void>
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function hostCallError(error: PluginResponse['error']): PluginHostCallError {
  return Object.assign(new Error(error?.message ?? 'host call failed'), {
    code: normalizePluginErrorCode(error?.code),
    retryable: error?.retryable === true,
    ...(error?.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs })
  })
}

const CANCELLED = pluginError('cancelled', 'cancelled')

/** A handler's own `{ code }` (a known one) reaches the panel; anything else is `action_failed`. */
function handlerFailure(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  return pluginError(
    normalizePluginErrorCode(code),
    error instanceof Error ? error.message : String(error)
  )
}

export function createPluginWorkerRuntime(
  options: PluginWorkerRuntimeOptions
): PluginWorkerRuntime {
  const send = options.send
  const importModule = options.importModule ?? ((specifier: string) => import(specifier))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const tables = createPluginWorkerApiTables()
  const commandHandlers = tables.commands
  const eventHandlers = tables.events
  const pendingHostCalls = new Map<number, (response: PluginResponse) => void>()
  const runningCommands = new Map<number, AbortController>()
  let nextHostCallId = 0
  let initialized = false
  let shuttingDown = false
  let deactivate: (() => unknown) | null = null

  function hostCall(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(hostCallError(CANCELLED))
    }
    const id = nextHostCallId++
    return new Promise<unknown>((resolve, reject) => {
      const abort = (): void => {
        pendingHostCalls.delete(id)
        send(pluginCancel(id))
        reject(hostCallError(CANCELLED))
      }
      signal?.addEventListener('abort', abort, { once: true })
      pendingHostCalls.set(id, (response) => {
        signal?.removeEventListener('abort', abort)
        if (response.error) {
          reject(hostCallError(response.error))
        } else {
          resolve(response.result)
        }
      })
      send(pluginRequest(id, method, params))
    })
  }

  async function handleInit(input: PluginWorkerInit): Promise<void> {
    if (initialized) {
      send(pluginWorkerLog('warn', 'ignoring duplicate init message'))
      return
    }
    initialized = true
    // File URLs support Windows ESM imports; split either separator for cross-platform manifests.
    const entryUrl = pathToFileURL(join(input.pluginRoot, ...input.mainEntry.split(/[\\/]/))).href
    options.prepareModuleLoading?.(input.pluginRoot)
    const module: unknown = await importModule(entryUrl)
    const activate = readExport(module, 'default')
    if (typeof activate !== 'function') {
      // Why name it: `export function activate` is the usual slip, and Orca never calls it.
      throw new Error(
        typeof readExport(module, 'activate') === 'function'
          ? `plugin entry ${input.mainEntry} exports activate by name, but Orca calls the default export: write \`export default function activate(orca)\``
          : `plugin entry ${input.mainEntry} has no default-exported activate function`
      )
    }
    const deactivateExport = readExport(module, 'deactivate')
    if (deactivateExport !== undefined && typeof deactivateExport !== 'function') {
      throw new Error(`plugin entry ${input.mainEntry} has a non-function deactivate export`)
    }
    deactivate = deactivateExport === undefined ? null : () => deactivateExport()
    const orca: PluginWorkerOrcaApi = createPluginWorkerOrcaApi({
      tables,
      hostCall: (method, params, callOptions) => hostCall(method, params, callOptions?.signal),
      postToPanels: (post) => send(pluginEvent(WORKER_EVENTS.panelPost, post)),
      log: (message) => send(pluginWorkerLog('info', message)),
      grantedCapabilities: input.grantedCapabilities
    })
    await activate(orca)
    send(pluginEvent(WORKER_EVENTS.ready, { commands: [...commandHandlers.keys()] }))
  }

  async function handleRequest(request: PluginRequest): Promise<void> {
    if (request.method === WORKER_METHODS.invokeCommand) {
      const parsed = pluginWorkerInvokeParamsSchema.safeParse(request.params)
      const handler = parsed.success ? commandHandlers.get(parsed.data.commandId) : undefined
      if (!parsed.success || !handler) {
        const commandId = parsed.success ? parsed.data.commandId : '(invalid)'
        send(
          pluginFailure(
            request.id,
            pluginError('unknown_method', `no handler registered for command ${commandId}`)
          )
        )
        return
      }
      const controller = new AbortController()
      runningCommands.set(request.id, controller)
      try {
        const value = await handler(parsed.data.args, { signal: controller.signal })
        send(pluginResult(request.id, value))
      } catch (error) {
        send(pluginFailure(request.id, pluginError('action_failed', toErrorMessage(error))))
      } finally {
        runningCommands.delete(request.id)
      }
      return
    }
    if (request.method === WORKER_METHODS.panelRequest) {
      await answerPanelRequest(request)
      return
    }
    if (request.method === WORKER_METHODS.deliverEvent) {
      const parsed = pluginWorkerDeliverParamsSchema.safeParse(request.params)
      for (const handler of parsed.success ? (eventHandlers.get(parsed.data.event) ?? []) : []) {
        try {
          await handler(parsed.success ? parsed.data.payload : undefined)
        } catch (error) {
          send(pluginWorkerLog('error', toErrorMessage(error)))
        }
      }
      send(pluginResult(request.id, null))
      return
    }
    send(
      pluginFailure(request.id, pluginError('unknown_method', `unknown request ${request.method}`))
    )
  }

  async function answerPanelRequest(request: PluginRequest): Promise<void> {
    const parsed = pluginWorkerPanelRequestParamsSchema.safeParse(request.params)
    const handler = parsed.success ? tables.panelRequests.get(parsed.data.name) : undefined
    if (!parsed.success || !handler) {
      const name = parsed.success ? parsed.data.name : '(invalid)'
      send(
        pluginFailure(request.id, pluginError('unknown_method', `no panel handler named ${name}`))
      )
      return
    }
    const controller = new AbortController()
    runningCommands.set(request.id, controller)
    try {
      const { input, panel } = parsed.data
      send(pluginResult(request.id, await handler(input, { panel, signal: controller.signal })))
    } catch (error) {
      send(pluginFailure(request.id, handlerFailure(error)))
    } finally {
      runningCommands.delete(request.id)
    }
  }

  function notifyDataChanged(payload: unknown): void {
    const change = pluginDataChangedSchema.safeParse(payload)
    for (const listener of change.success ? tables.dataListeners[change.data.area] : []) {
      try {
        listener({ key: change.success ? change.data.key : '' })
      } catch (error) {
        send(pluginWorkerLog('error', toErrorMessage(error)))
      }
    }
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    try {
      await deactivate?.()
    } catch (error) {
      send(pluginWorkerLog('error', toErrorMessage(error)))
    }
    exit(0)
  }

  return {
    async handleMessage(raw) {
      const message = readPluginEnvelope(raw)
      if (!message) {
        send(pluginWorkerLog('warn', 'ignoring malformed parent message'))
        return
      }
      try {
        switch (message.kind) {
          case 'evt': {
            if (message.event === WORKER_EVENTS.shutdown) {
              await shutdown()
              return
            }
            if (message.event === WORKER_EVENTS.dataChanged) {
              notifyDataChanged(message.payload)
              return
            }
            const init =
              message.event === WORKER_EVENTS.init
                ? pluginWorkerInitSchema.safeParse(message.payload)
                : null
            if (init?.success) {
              await handleInit(init.data)
            } else {
              send(pluginWorkerLog('warn', 'ignoring malformed parent message'))
            }
            return
          }
          case 'req':
            await handleRequest(message)
            return
          case 'res': {
            const settle = pendingHostCalls.get(message.id)
            pendingHostCalls.delete(message.id)
            settle?.(message)
            return
          }
          case 'cancel':
            runningCommands.get(message.id)?.abort()
        }
      } catch (error) {
        // Failed activation cannot become ready; report and exit without waiting for the parent timeout.
        send(pluginWorkerFatal(toErrorMessage(error)))
        exit(1)
      }
    }
  }
}

function readExport(module: unknown, name: 'default' | 'activate' | 'deactivate'): unknown {
  return typeof module === 'object' && module !== null && name in module ? module[name] : undefined
}
