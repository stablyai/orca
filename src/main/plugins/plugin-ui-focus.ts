import {
  PluginOpaqueJoinKeyMap,
  pluginFocusedSurfacesEqual,
  projectPluginUiFocusReport,
  type PluginFocusedSurface
} from '../../shared/plugins/plugin-focused-surface'

/** Last UI-reported focus, projected once so every plugin sees the same snapshot. */
export class PluginUiFocusSnapshot {
  private surface: PluginFocusedSurface | null = null
  private readonly joinKeys = new PluginOpaqueJoinKeyMap()

  get(): PluginFocusedSurface | null {
    return this.surface
  }

  apply(raw: unknown): { changed: boolean; surface: PluginFocusedSurface | null } {
    const surface = projectPluginUiFocusReport(raw, this.joinKeys)
    const changed = !pluginFocusedSurfacesEqual(this.surface, surface)
    if (changed) {
      this.surface = surface
    }
    return { changed, surface: this.surface }
  }
}
