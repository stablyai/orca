import { pluginWorkerPanelMessageParamsSchema } from '../../../shared/plugins/workers/plugin-host-protocol'
import {
  pluginError,
  pluginFailure,
  pluginResult,
  type PluginEnvelope,
  type PluginRequest
} from '../../../shared/plugins/frames/plugin-protocol'

type PanelMessageHandler = (message: unknown, context: { signal: AbortSignal }) => unknown

/** `orca.panels`, as a plugin's `activate(orca)` sees it. */
export type PluginPanelMessagesApi = {
  /** One handler per panel id; its JSON reply goes back to `orca.panel.postMessage`. */
  onMessage(panelId: string, handler: PanelMessageHandler): { dispose(): void }
}

/** Worker side of panel messages: the handlers a plugin registered and the `panel.message` requests they answer. */
export function createWorkerPanelMessages(options: {
  send: (message: PluginEnvelope) => void
  /** Requests the host may cancel, shared with commands so one `cancel` handler covers both. */
  running: Map<number, AbortController>
}) {
  const handlers = new Map<string, PanelMessageHandler>()
  const api: PluginPanelMessagesApi = Object.freeze({
    onMessage(panelId, handler) {
      if (typeof panelId !== 'string' || panelId === '') {
        throw new TypeError('orca.panels.onMessage needs a panel id')
      }
      if (typeof handler !== 'function') {
        throw new TypeError('orca.panels.onMessage needs a handler')
      }
      if (handlers.has(panelId)) {
        throw new Error(`a message handler is already registered for panel ${panelId}`)
      }
      handlers.set(panelId, handler)
      return {
        dispose: () => {
          if (handlers.get(panelId) === handler) {
            handlers.delete(panelId)
          }
        }
      }
    }
  })

  async function deliver(request: PluginRequest): Promise<void> {
    const parsed = pluginWorkerPanelMessageParamsSchema.safeParse(request.params)
    const handler = parsed.success ? handlers.get(parsed.data.panelId) : undefined
    if (!parsed.success || !handler) {
      const panelId = parsed.success ? parsed.data.panelId : '(invalid)'
      options.send(
        pluginFailure(
          request.id,
          pluginError('unknown_method', `no message handler registered for panel ${panelId}`)
        )
      )
      return
    }
    const controller = new AbortController()
    options.running.set(request.id, controller)
    try {
      const reply = await handler(parsed.data.message, { signal: controller.signal })
      options.send(pluginResult(request.id, reply === undefined ? null : reply))
    } catch (error) {
      // Why no stack: the message travels on to a panel, which must not see worker paths.
      const message = error instanceof Error ? error.message : String(error)
      options.send(pluginFailure(request.id, pluginError('action_failed', message)))
    } finally {
      options.running.delete(request.id)
    }
  }

  return { api, deliver }
}
