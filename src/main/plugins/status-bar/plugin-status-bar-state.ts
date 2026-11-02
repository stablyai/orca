import type { PluginStatusBarItemPatch } from '../../../shared/plugins/contributions/plugin-status-bar-item-contribution'
import type { PluginStatusBarOverrides } from '../../../shared/plugins/contributions/plugin-status-bar-state'

/** Which install of a plugin set the changes: a new folder or manifest (an update) starts over. */
export function pluginStatusBarRevision(plugin: { rootDir: string; manifest: unknown }): string {
  return `${plugin.rootDir}\0${JSON.stringify(plugin.manifest)}`
}

/** What workers set on their status bar items, layered over the manifest's values. Session-only. */
export class PluginStatusBarState {
  private overrides: PluginStatusBarOverrides = {}
  private readonly revisions = new Map<string, string>()
  private readonly listeners = new Set<(overrides: PluginStatusBarOverrides) => void>()

  update(
    pluginKey: string,
    revision: string,
    itemId: string,
    patch: PluginStatusBarItemPatch
  ): void {
    const items = this.revisions.get(pluginKey) === revision ? this.overrides[pluginKey] : {}
    this.revisions.set(pluginKey, revision)
    const merged = { ...items?.[itemId], ...patch }
    // Why replace, not mutate: listeners and the renderer compare snapshots by identity.
    this.overrides = { ...this.overrides, [pluginKey]: { ...items, [itemId]: merged } }
    this.emit()
  }

  /** Drops changes of plugins now disabled, removed or updated (`revisionOf` null or different),
   *  so a re-enabled plugin starts from its manifest values. */
  prune(revisionOf: (pluginKey: string) => string | null): void {
    const stale = [...this.revisions].filter(([key, revision]) => revisionOf(key) !== revision)
    if (stale.length === 0) {
      return
    }
    const next = { ...this.overrides }
    for (const [key] of stale) {
      this.revisions.delete(key)
      delete next[key]
    }
    this.overrides = next
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
