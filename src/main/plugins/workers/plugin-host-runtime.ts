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
import type { PluginEventName } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_V1_EVENT_ALIASES } from '../../../shared/plugins/contributions/plugin-event-contribution'
import {
  PLUGIN_HOST_API_MINOR,
  pluginHostMethodsFor
} from '../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_HOST_API_MAJOR } from '../../../shared/plugins/workers/plugin-host-api-major'

/** A failed host call or command: the same `{ code, message, retryable }` frames get. */
// Why: format 1 handlers read `worktreeId`; newer payloads name it `workspaceId`.
function withV1WorktreeId(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('workspaceId' in payload)) {
    return payload
  }
  return 'worktreeId' in payload ? payload : { ...payload, worktreeId: payload.workspaceId }
}

export type PluginHostCallError = Error & {
  code: PluginErrorCode
  retryable: boolean
  retryAfterMs?: number
}

export type PluginDisposable = { dispose(): void }

/** API surface handed to a plugin's `activate(orca)` export (host API 1). */
export type PluginWorkerOrcaApi = {
  api: { readonly major: number; readonly minor: number }
  commands: {
    register(
      commandId: string,
      handler: (args: unknown, context: { signal: AbortSignal }) => unknown
    ): PluginDisposable
  }
  events: {
    on(
      event: PluginEventName,
      handler: (payload: unknown) => void | Promise<void>
    ): PluginDisposable
  }
  host: {
    call(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>
    /** Whether this host implements `method` for workers. */
    has(method: string): boolean
  }
  /** Consented capability kinds (informational — the host re-gates). */
  grantedCapabilities: readonly string[]
  log(message: string): void
}

export type PluginWorkerRuntimeOptions = {
  send: (message: PluginEnvelope) => void
  importModule?: (specifier: string) => Promise<unknown>
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

const WORKER_METHOD_NAMES: ReadonlySet<string> = new Set(pluginHostMethodsFor('worker'))

export function createPluginWorkerRuntime(
  options: PluginWorkerRuntimeOptions
): PluginWorkerRuntime {
  const send = options.send
  const importModule = options.importModule ?? ((specifier: string) => import(specifier))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const commandHandlers = new Map<
    string,
    (args: unknown, context: { signal: AbortSignal }) => unknown
  >()
  const eventHandlers = new Map<string, Set<(payload: unknown) => void | Promise<void>>>()
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
    const module: unknown = await importModule(entryUrl)
    const activate = readExport(module, 'default')
    if (typeof activate !== 'function') {
      throw new Error(`plugin entry ${input.mainEntry} has no default-exported activate function`)
    }
    const deactivateExport = readExport(module, 'deactivate')
    if (deactivateExport !== undefined && typeof deactivateExport !== 'function') {
      throw new Error(`plugin entry ${input.mainEntry} has a non-function deactivate export`)
    }
    deactivate = deactivateExport === undefined ? null : () => deactivateExport()
    const orca: PluginWorkerOrcaApi = Object.freeze({
      api: Object.freeze({ major: PLUGIN_HOST_API_MAJOR, minor: PLUGIN_HOST_API_MINOR }),
      commands: Object.freeze({
        register(
          commandId: string,
          handler: Parameters<PluginWorkerOrcaApi['commands']['register']>[1]
        ) {
          commandHandlers.set(commandId, handler)
          return {
            dispose: () => {
              commandHandlers.delete(commandId)
            }
          }
        }
      }),
      events: Object.freeze({
        on(event: PluginEventName, handler: (payload: unknown) => void | Promise<void>) {
          // Why: format 1 workers still listen under the old worktree.* names.
          const name = PLUGIN_V1_EVENT_ALIASES.get(event) ?? event
          const handlers = eventHandlers.get(name) ?? new Set()
          eventHandlers.set(name, handlers)
          const v1Payload = name !== event || event === 'agent.status.changed'
          const entry = (payload: unknown): void | Promise<void> =>
            handler(v1Payload ? withV1WorktreeId(payload) : payload)
          handlers.add(entry)
          return {
            dispose: () => {
              handlers.delete(entry)
            }
          }
        }
      }),
      host: Object.freeze({
        call: (method: string, params?: unknown, callOptions?: { signal?: AbortSignal }) =>
          hostCall(method, params, callOptions?.signal),
        has: (method: string) => WORKER_METHOD_NAMES.has(method)
      }),
      grantedCapabilities: Object.freeze([...input.grantedCapabilities]),
      log(message: string) {
        send(pluginWorkerLog('info', String(message)))
      }
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

function readExport(module: unknown, name: 'default' | 'deactivate'): unknown {
  return typeof module === 'object' && module !== null && name in module ? module[name] : undefined
}
