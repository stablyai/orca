import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  pluginWorkerParentMessageSchema,
  type PluginWorkerChildMessage
} from '../../shared/plugins/plugin-host-protocol'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'

export type PluginHostCallError = Error & { code?: string }

/** Experimental activate(orca) surface; host capability checks remain authoritative. */
export type PluginWorkerOrcaApi = {
  commands: {
    register(commandId: string, handler: (args: unknown) => unknown): void
  }
  events: {
    on(event: PluginEventName, handler: (payload: unknown) => void | Promise<void>): void
  }
  host: {
    call(method: string, params?: unknown): Promise<unknown>
  }
  /** Consented capability kinds (informational — the host re-gates). */
  grantedCapabilities: readonly string[]
  log(message: string): void
}

export type PluginWorkerRuntimeOptions = {
  send: (message: PluginWorkerChildMessage) => void
  importModule?: (specifier: string) => Promise<unknown>
  exit?: (code: number) => void
}

export type PluginWorkerRuntime = {
  handleMessage(raw: unknown): Promise<void>
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

export function createPluginWorkerRuntime(
  options: PluginWorkerRuntimeOptions
): PluginWorkerRuntime {
  const send = options.send
  const importModule = options.importModule ?? ((specifier: string) => import(specifier))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const commandHandlers = new Map<string, (args: unknown) => unknown>()
  const eventHandlers = new Map<string, ((payload: unknown) => void | Promise<void>)[]>()
  const pendingHostCalls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: PluginHostCallError) => void }
  >()
  let nextHostCallId = 0
  let initialized = false
  let shuttingDown = false
  let deactivate: (() => unknown) | null = null

  async function handleInit(input: {
    pluginRoot: string
    mainEntry: string
    grantedCapabilities: string[]
  }): Promise<void> {
    if (initialized) {
      send({ type: 'log', level: 'warn', message: 'ignoring duplicate init message' })
      return
    }
    initialized = true
    // File URLs support Windows ESM imports; split either separator for cross-platform manifests.
    const entryUrl = pathToFileURL(join(input.pluginRoot, ...input.mainEntry.split(/[\\/]/))).href
    const module = (await importModule(entryUrl)) as { default?: unknown; deactivate?: unknown }
    const activate = module?.default
    if (typeof activate !== 'function') {
      throw new Error(`plugin entry ${input.mainEntry} has no default-exported activate function`)
    }
    if (module.deactivate !== undefined && typeof module.deactivate !== 'function') {
      throw new Error(`plugin entry ${input.mainEntry} has a non-function deactivate export`)
    }
    deactivate = (module.deactivate as (() => unknown) | undefined) ?? null
    const orca: PluginWorkerOrcaApi = {
      commands: {
        register(commandId, handler) {
          commandHandlers.set(commandId, handler)
        }
      },
      events: {
        on(event, handler) {
          const handlers = eventHandlers.get(event) ?? []
          handlers.push(handler)
          eventHandlers.set(event, handlers)
        }
      },
      host: {
        call(method, params) {
          const callId = nextHostCallId++
          return new Promise<unknown>((resolve, reject) => {
            pendingHostCalls.set(callId, { resolve, reject })
            send({ type: 'hostCall', callId, method, params })
          })
        }
      },
      grantedCapabilities: input.grantedCapabilities,
      log(message) {
        send({ type: 'log', level: 'info', message: String(message).slice(0, 8192) })
      }
    }
    await activate(orca)
    send({ type: 'ready', commands: [...commandHandlers.keys()] })
  }

  return {
    async handleMessage(raw) {
      const parsed = pluginWorkerParentMessageSchema.safeParse(raw)
      if (!parsed.success) {
        send({ type: 'log', level: 'warn', message: 'ignoring malformed parent message' })
        return
      }
      const message = parsed.data
      try {
        switch (message.type) {
          case 'init': {
            await handleInit(message)
            return
          }
          case 'invokeCommand': {
            const handler = commandHandlers.get(message.commandId)
            if (!handler) {
              send({
                type: 'commandResult',
                callId: message.callId,
                ok: false,
                error: `no handler registered for command ${message.commandId}`
              })
              return
            }
            try {
              const value = await handler(message.args)
              send({ type: 'commandResult', callId: message.callId, ok: true, value })
            } catch (error) {
              send({
                type: 'commandResult',
                callId: message.callId,
                ok: false,
                error: toErrorMessage(error)
              })
            }
            return
          }
          case 'deliverEvent': {
            const handlers = eventHandlers.get(message.event) ?? []
            for (const handler of handlers) {
              try {
                await handler(message.payload)
              } catch (error) {
                send({ type: 'log', level: 'error', message: toErrorMessage(error) })
              }
            }
            send({ type: 'eventAck', eventId: message.eventId })
            return
          }
          case 'hostResult': {
            const pending = pendingHostCalls.get(message.callId)
            if (!pending) {
              return
            }
            pendingHostCalls.delete(message.callId)
            if (message.ok) {
              pending.resolve(message.value)
            } else {
              const error: PluginHostCallError = new Error(message.error ?? 'host call failed')
              error.code = message.errorCode
              pending.reject(error)
            }
            return
          }
          case 'shutdown': {
            if (shuttingDown) {
              return
            }
            shuttingDown = true
            try {
              await deactivate?.()
            } catch (error) {
              send({ type: 'log', level: 'error', message: toErrorMessage(error).slice(0, 8192) })
            }
            exit(0)
          }
        }
      } catch (error) {
        // Failed activation cannot become ready; report and exit without waiting for the parent timeout.
        send({ type: 'fatal', error: toErrorMessage(error) })
        exit(1)
      }
    }
  }
}
