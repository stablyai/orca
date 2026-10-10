import { capabilityKinds } from '../../shared/plugins/plugin-capabilities'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginContentVerifier } from './plugin-content-integrity'
import type { PluginHostServices } from './plugin-host-method-bindings'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginPanelController } from './plugin-panel-controller'
import { PluginStatusBarController } from './plugin-status-bar-controller'

type PluginClientSurfacesHost = {
  /** The plugin when it is valid and may run work now; null otherwise. */
  resolveApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  ensureWorker: (plugin: ValidDiscoveredPlugin) => Promise<PluginWorkerHandle>
  contentVerifier: Pick<PluginContentVerifier, 'verify'>
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown,
    options: { viaPanel: boolean }
  ) => Promise<PluginPanelActionOutcome>
  log: (pluginKey: string, level: 'warn' | 'error') => (line: string) => void
  statusBarIntervalMs?: number
}

/**
 * Plugin UI rendered by clients: sandboxed panels (documents, actions, and
 * the live worker channel) and worker-driven status-bar items. Live traffic
 * needs a running worker, so this is where it activates one and where the
 * panelMessaging capability is enforced for panel → worker messages (worker →
 * panel calls are gated by the host API spec table).
 */
export class PluginClientSurfaces {
  readonly panels: PluginPanelController
  readonly statusBar: PluginStatusBarController

  constructor(private readonly host: PluginClientSurfacesHost) {
    this.panels = new PluginPanelController({
      resolveApprovedPlugin: host.resolveApprovedPlugin,
      contentVerifier: host.contentVerifier,
      executeHostCall: (pluginKey, method, params) =>
        host.executeHostCall(pluginKey, method, params, { viaPanel: true }),
      log: (pluginKey) => host.log(pluginKey, 'error'),
      deliverToWorker: (pluginKey, panelId, message) =>
        this.deliverToWorker(pluginKey, panelId, message)
    })
    this.statusBar = new PluginStatusBarController({
      resolveApprovedPlugin: host.resolveApprovedPlugin,
      ensureWorker: host.ensureWorker,
      log: (pluginKey) => host.log(pluginKey, 'warn'),
      intervalMs: host.statusBarIntervalMs
    })
  }

  hostServices(): Pick<PluginHostServices, 'statusBar' | 'panels'> {
    return {
      statusBar: {
        update: (pluginKey, itemId, state) => this.statusBar.update(pluginKey, itemId, state)
      },
      panels: {
        postMessage: (pluginKey, panelId, message) =>
          this.panels.postToPanel(pluginKey, panelId, message)
      }
    }
  }

  async deliverToWorker(
    pluginKey: string,
    panelId: string,
    message: unknown
  ): Promise<PluginPanelActionOutcome> {
    const plugin = this.host.resolveApprovedPlugin(pluginKey)
    if (!plugin) {
      return {
        ok: false,
        code: 'consent_required',
        error: 'plugin is not enabled with current consent'
      }
    }
    // Approved plugins hold exactly their consented manifest capabilities.
    if (!capabilityKinds(plugin.manifest.capabilities).includes('panelMessaging')) {
      return {
        ok: false,
        code: 'capability_denied',
        error: 'plugin does not have the "panelMessaging" capability'
      }
    }
    if (!plugin.manifest.main) {
      return { ok: false, code: 'unavailable', error: 'plugin has no worker' }
    }
    try {
      // Why ensure: a panel asking for its first snapshot is the trigger that
      // starts an idle or reaped worker.
      const handle = await this.host.ensureWorker(plugin)
      return { ok: true, value: { delivered: handle.deliverPanelMessage(panelId, message) } }
    } catch (error) {
      return {
        ok: false,
        code: 'unavailable',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Worker-controller hooks: status-bar items live exactly as long as the
   *  worker that published them, and that worker is exempt from idle reap
   *  while any of them is visible. */
  workerHooks(onWorkerGone: (pluginKey: string) => void): {
    onWorkerGone: (pluginKey: string) => void
    isPinned: (pluginKey: string) => boolean
  } {
    return {
      onWorkerGone: (pluginKey) => {
        onWorkerGone(pluginKey)
        this.statusBar.clearPlugin(pluginKey)
      },
      isPinned: (pluginKey) => this.statusBar.hasVisibleItems(pluginKey)
    }
  }

  dispose(): void {
    this.panels.dispose()
    this.statusBar.dispose()
  }
}
