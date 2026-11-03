import {
  PLUGIN_CARD_FIELDS_LIMITS,
  type PluginCardFields,
  type PluginCardFieldsSnapshot
} from '../../../shared/plugins/contributions/plugin-card-fields-state'

/** What workers set for their cards. Session-only; pushes are coalesced so a chatty worker
 *  costs the windows at most one redraw per push interval. */
export class PluginCardFieldsState {
  private fields: PluginCardFieldsSnapshot = {}
  private readonly revisions = new Map<string, string>()
  private readonly listeners = new Set<(fields: PluginCardFieldsSnapshot) => void>()
  private pending: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly pushIntervalMs: number = PLUGIN_CARD_FIELDS_LIMITS.pushIntervalMs) {}

  set(
    pluginKey: string,
    revision: string,
    workspaceId: string,
    next: PluginCardFields | null
  ): void {
    const own = this.revisions.get(pluginKey) === revision ? this.fields[pluginKey] : {}
    this.revisions.set(pluginKey, revision)
    const updated = { ...own }
    if (next === null) {
      delete updated[workspaceId]
    } else {
      updated[workspaceId] = next
    }
    // Why replace, not mutate: the renderer compares snapshots by identity.
    this.fields = { ...this.fields, [pluginKey]: updated }
    this.schedule()
  }

  /** Drops fields of plugins now disabled, removed or updated. */
  prune(revisionOf: (pluginKey: string) => string | null): void {
    const stale = [...this.revisions].filter(([key, revision]) => revisionOf(key) !== revision)
    if (stale.length === 0) {
      return
    }
    const next = { ...this.fields }
    for (const [key] of stale) {
      this.revisions.delete(key)
      delete next[key]
    }
    this.fields = next
    this.schedule()
  }

  snapshot(): PluginCardFieldsSnapshot {
    return this.fields
  }

  onChanged(listener: (fields: PluginCardFieldsSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private schedule(): void {
    if (this.pending) {
      return
    }
    this.pending = setTimeout(() => {
      this.pending = null
      for (const listener of this.listeners) {
        listener(this.fields)
      }
    }, this.pushIntervalMs)
  }
}
