import type { PluginViewColorScheme } from '../../../shared/plugins/view/plugin-view-protocol'

export const PLUGIN_SHOT_VISIBLE_THEME_REASON =
  'the Orca window is visible; capturing in the current theme so the app is not repainted'

/** `--theme` repaints the whole app, so it only applies while nobody can see the window. */
export function pluginShotThemeDecision(
  requested: PluginViewColorScheme | undefined,
  windowShown: boolean
): { colorScheme?: PluginViewColorScheme; themeReason?: string } {
  if (requested === undefined) {
    return {}
  }
  return windowShown
    ? { themeReason: PLUGIN_SHOT_VISIBLE_THEME_REASON }
    : { colorScheme: requested }
}

/** Shown means on screen: a hidden or minimized window is painted for the capture only. */
export function isPluginShotWindowShown(window: {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
}): boolean {
  return !window.isDestroyed() && window.isVisible() && !window.isMinimized()
}
