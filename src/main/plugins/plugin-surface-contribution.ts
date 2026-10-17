import type { PluginPanelSurface } from '../../shared/plugins/plugin-panel-bridge'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

/** The contribution a session renders: a sidebar panel or a settings page. */
export function findSurfaceContribution(
  plugin: ValidDiscoveredPlugin | null,
  surface: PluginPanelSurface,
  id: string
): { id: string; entry: string } | null {
  const contributions =
    surface === 'settingsPage'
      ? plugin?.manifest.contributes.settingsPages
      : plugin?.manifest.contributes.panels
  return contributions?.find((entry) => entry.id === id) ?? null
}
