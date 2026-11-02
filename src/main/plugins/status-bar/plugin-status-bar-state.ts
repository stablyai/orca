import type { PluginStatusBarItemPatch } from '../../../shared/plugins/contributions/plugin-status-bar-item-contribution'
import type { PluginStatusBarOverrides } from '../../../shared/plugins/contributions/plugin-status-bar-state'

/** What workers set on their status bar items, layered over the manifest's values. Session-only. */
export class PluginStatusBarState {
  private overrides: PluginStatusBarOverrides = {}
  private readonly listeners = new Set<(overrides: PluginStatusBarOverrides) => void>()

  update(pluginKey: string, itemId: string, patch: PluginStatusBarItemPatch): void {
    const items = this.overrides[pluginKey] ?? {}
    const merged = { ...items[itemId], ...patch }
    // Why replace, not mutate: listeners and the renderer compare snapshots by identity.
    this.overrides = { ...this.overrides, [pluginKey]: { ...items, [itemId]: merged } }
    this.emit()
  }

  snapshot(): PluginStatusBarOverrides {
    return this.overrides
  }

  onChanged(listener: (overrides: PluginStatusBarOverrides) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.overrides)
    }
  }
}
