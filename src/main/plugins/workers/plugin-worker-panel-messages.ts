import {
  PLUGIN_WORKER_MAX_PENDING_PANEL_MESSAGES,
  WORKER_METHODS
} from '../../../shared/plugins/workers/plugin-host-protocol'
import {
  normalizePluginErrorCode,
  pluginCancel,
  pluginRequest,
  type PluginEnvelope,
  type PluginHostCallOutcome,
  type PluginResponse
} from '../../../shared/plugins/frames/plugin-protocol'

type PendingPanelMessage = {
  resolve: (outcome: PluginHostCallOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

const WORKER_STOPPED_OUTCOME = {
  ok: false,
  code: 'unavailable',
  error: 'plugin worker stopped before answering'
} as const satisfies PluginHostCallOutcome

/** Host side of one worker's panel messages: the `panel.message` requests it has sent and not had answered. */
export function createPluginWorkerPanelMessages(options: {
  send: (message: PluginEnvelope) => void
  /** Draws from the worker's one id space, shared with commands and events. */
  nextId: () => number
  timeoutMs: number
  isRunning: () => boolean
  onActivity: () => void
}) {
  const pending = new Map<number, PendingPanelMessage>()
  return {
    size: () => pending.size,
    deliver(panelId: string, message: unknown): Promise<PluginHostCallOutcome> {
      if (!options.isRunning()) {
        return Promise.resolve({ ...WORKER_STOPPED_OUTCOME, error: 'plugin worker is not running' })
      }
      if (pending.size >= PLUGIN_WORKER_MAX_PENDING_PANEL_MESSAGES) {
        return Promise.resolve({
          ok: false,
          code: 'rate_limited',
          error: 'too many panel messages are waiting for the worker'
        })
      }
      options.onActivity()
      const id = options.nextId()
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          // Tell the handler too, so it stops instead of running on unobserved.
          options.send(pluginCancel(id))
          resolve({
            ok: false,
            code: 'timeout',
            error: `the worker did not answer within ${options.timeoutMs}ms`
          })
        }, options.timeoutMs)
        pending.set(id, { resolve, timer })
        options.send(pluginRequest(id, WORKER_METHODS.deliverPanelMessage, { panelId, message }))
      })
    },
    /** True when `response` answered a panel message. */
    settle(response: PluginResponse): boolean {
      const entry = pending.get(response.id)
      if (!entry) {
        return false
      }
      clearTimeout(entry.timer)
      pending.delete(response.id)
      entry.resolve(
        response.error
          ? {
              ok: false,
              code: normalizePluginErrorCode(response.error.code),
              error: response.error.message
            }
          : { ok: true, value: response.result ?? null }
      )
      return true
    },
    rejectAll(): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.resolve(WORKER_STOPPED_OUTCOME)
      }
      pending.clear()
    }
  }
}
