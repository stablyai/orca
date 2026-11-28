import {
  pluginEvent,
  type PluginEnvelope,
  type PluginRequest
} from '../../../../shared/plugins/frames/plugin-protocol'
import { WORKER_EVENTS } from '../../../../shared/plugins/workers/plugin-host-protocol'
import type { PluginWorkerApiTables } from '../../../../shared/plugins/workers/plugin-worker-orca-api'

export class PluginWorkerIdleReport {
  enabled = false
  private handling = 0
  private lastRequest = -1

  constructor(
    private readonly tables: PluginWorkerApiTables,
    private readonly pendingCalls: { readonly size: number },
    private readonly send: (message: PluginEnvelope) => void
  ) {}

  async handleRequest(
    request: PluginRequest,
    handle: (request: PluginRequest) => Promise<void>
  ): Promise<void> {
    this.lastRequest = request.id
    this.handling++
    try {
      await handle(request)
    } finally {
      this.handling--
      this.report()
    }
  }

  afterHostCall(): void {
    if (this.enabled && this.handling === 0) {
      setImmediate(() => this.report())
    }
  }

  report(): void {
    if (
      this.enabled &&
      this.handling === 0 &&
      this.pendingCalls.size === 0 &&
      this.tables.dataListeners.storage.size === 0 &&
      this.tables.dataListeners.settings.size === 0 &&
      ![...this.tables.events.values()].some((handlers) => handlers.size > 0)
    ) {
      this.send(pluginEvent(WORKER_EVENTS.idle, { through: this.lastRequest }))
    }
  }
}
