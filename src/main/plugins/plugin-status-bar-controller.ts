import {
  comparePluginStatusBarItems,
  PLUGIN_STATUS_BAR_UPDATE_INTERVAL_MS,
  type PluginStatusBarItemSnapshot,
  type PluginStatusBarItemState
} from '../../shared/plugins/plugin-status-bar'
import { pluginPanelTabKey } from '../../shared/plugins/plugin-tab-key'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

type PluginStatusBarControllerOptions = {
  /** The plugin when it is valid and may run work now; null otherwise. */
  resolveApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  ensureWorker: (plugin: ValidDiscoveredPlugin) => Promise<unknown>
  log: (pluginKey: string) => (line: string) => void
  intervalMs?: number
  now?: () => number
}

type StatusBarListener = (items: PluginStatusBarItemSnapshot[]) => void

function sameState(a: PluginStatusBarItemState, b: PluginStatusBarItemState): boolean {
  return (
    a.text === b.text &&
    a.tooltip === b.tooltip &&
    a.severity === b.severity &&
    a.visible === b.visible
  )
}

/**
 * Owns worker-published status-bar item state. Items live exactly as long as
 * the worker that published them; clients receive whole snapshots, throttled
 * so any burst of updates reaches the renderer at most every interval with
 * only the latest state per item.
 */
export class PluginStatusBarController {
  private readonly items = new Map<string, Map<string, PluginStatusBarItemState>>()
  private readonly listeners = new Set<StatusBarListener>()
  private readonly intervalMs: number
  private readonly now: () => number
  private lastPublishAt = Number.NEGATIVE_INFINITY
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private readonly activated = new Map<string, ValidDiscoveredPlugin>()

  constructor(private readonly options: PluginStatusBarControllerOptions) {
    this.intervalMs = options.intervalMs ?? PLUGIN_STATUS_BAR_UPDATE_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
  }

  update(
    pluginKey: string,
    itemId: string,
    state: PluginStatusBarItemState
  ): { ok: true } | { ok: false; error: string } {
    const plugin = this.options.resolveApprovedPlugin(pluginKey)
    if (!plugin) {
      return { ok: false, error: 'plugin is not enabled' }
    }
    if (!plugin.manifest.contributes.statusBarItems.some((item) => item.id === itemId)) {
      return { ok: false, error: `unknown status bar item: ${itemId}` }
    }
    let pluginItems = this.items.get(pluginKey)
    if (!pluginItems) {
      pluginItems = new Map()
      this.items.set(pluginKey, pluginItems)
    }
    const previous = pluginItems.get(itemId)
    pluginItems.set(itemId, state)
    if (!previous || !sameState(previous, state)) {
      this.schedulePublish()
    }
    return { ok: true }
  }

  clearPlugin(pluginKey: string): void {
    if (this.items.delete(pluginKey)) {
      this.schedulePublish()
    }
  }

  hasVisibleItems(pluginKey: string): boolean {
    for (const state of this.items.get(pluginKey)?.values() ?? []) {
      if (state.visible) {
        return true
      }
    }
    return false
  }

  /** Visible items of currently approved plugins, in render order. */
  snapshot(): PluginStatusBarItemSnapshot[] {
    const entries: (PluginStatusBarItemSnapshot & { order: number })[] = []
    for (const [pluginKey, pluginItems] of this.items) {
      const plugin = this.options.resolveApprovedPlugin(pluginKey)
      if (!plugin) {
        continue
      }
      plugin.manifest.contributes.statusBarItems.forEach((contribution, order) => {
        const state = pluginItems.get(contribution.id)
        if (!state?.visible || state.text.trim() === '') {
          return
        }
        entries.push({
          pluginKey,
          pluginName: plugin.manifest.name,
          itemId: contribution.id,
          alignment: contribution.alignment ?? 'right',
          priority: contribution.priority ?? 0,
          ...(contribution.command ? { command: contribution.command } : {}),
          ...(contribution.panel
            ? { panelTabKey: pluginPanelTabKey(pluginKey, contribution.panel) }
            : {}),
          text: state.text,
          ...(state.tooltip ? { tooltip: state.tooltip } : {}),
          severity: state.severity,
          order
        })
      })
    }
    return entries.sort(comparePluginStatusBarItems).map(({ order: _order, ...item }) => item)
  }

  /**
   * Snapshot for a client that renders a status bar, and the activation
   * trigger for status-bar plugins: their text needs a running worker. Each
   * approved plugin revision is started once, so a worker reaped while all its
   * items are hidden stays down until a new revision or re-approval.
   */
  listForSurface(plugins: readonly DiscoveredPlugin[]): PluginStatusBarItemSnapshot[] {
    const candidates = new Map<string, ValidDiscoveredPlugin>()
    for (const entry of plugins) {
      if (isInvalidDiscoveredPlugin(entry) || !entry.manifest.main) {
        continue
      }
      if (
        entry.manifest.contributes.statusBarItems.length > 0 &&
        this.options.resolveApprovedPlugin(entry.pluginKey) === entry
      ) {
        candidates.set(entry.pluginKey, entry)
      }
    }
    for (const [pluginKey, plugin] of this.activated) {
      if (candidates.get(pluginKey) !== plugin) {
        this.activated.delete(pluginKey)
      }
    }
    for (const [pluginKey, plugin] of candidates) {
      if (this.activated.has(pluginKey)) {
        continue
      }
      this.activated.set(pluginKey, plugin)
      const log = this.options.log(pluginKey)
      void this.options.ensureWorker(plugin).catch((error: unknown) => {
        log(
          `status bar activation failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
    return this.snapshot()
  }

  onChanged(listener: StatusBarListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer)
      this.publishTimer = null
    }
    this.items.clear()
    this.activated.clear()
    this.listeners.clear()
  }

  private schedulePublish(): void {
    if (this.publishTimer) {
      return
    }
    const delay = Math.max(0, this.lastPublishAt + this.intervalMs - this.now())
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      this.lastPublishAt = this.now()
      const items = this.snapshot()
      for (const listener of this.listeners) {
        listener(items)
      }
    }, delay)
    this.publishTimer.unref?.()
  }
}
