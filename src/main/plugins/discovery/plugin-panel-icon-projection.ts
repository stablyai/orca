import { resolvePluginPanelPathIcon } from '../../../shared/plugins/contributions/plugin-panel-path-icon'
import {
  pluginPanelIconSlot,
  pluginPanelImageIconPath
} from '../../../shared/plugins/contributions/plugin-panel-image-icon'
import { pluginPanelTabKey } from '../../../shared/plugins/frames/plugin-tab-key'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginPanelContribution } from '../../../shared/plugins/contributions/plugin-panel-contribution'
import type { PluginHostPanel } from '../../../shared/plugins/plugin-list-entry'

/** A name stays in `icon`; a path icon goes to `iconPath` and an image icon to `iconImage` as
 *  `imageUrl`, the URL main serves it under, so older clients never see an object. */
export function projectPluginPanelIcon(
  icon: PluginPanelContribution['icon'],
  imageUrl: string | null = null
): Pick<PluginHostPanel, 'icon' | 'iconPath' | 'iconImage'> {
  if (typeof icon === 'string') {
    return { icon }
  }
  if (pluginPanelImageIconPath(icon) !== undefined) {
    return imageUrl ? { iconImage: imageUrl } : {}
  }
  const iconPath = icon ? resolvePluginPanelPathIcon(icon) : null
  return iconPath ? { iconPath } : {}
}

/** The panels clients see. `imageUrl(slot, path)` is the URL main serves a contribution image
 *  under, or null when it serves none. */
export function projectPluginPanels(
  plugin: Pick<ValidDiscoveredPlugin, 'pluginKey' | 'manifest' | 'isDev' | 'devChangeCount'>,
  imageUrl: (slot: string, path: string | undefined) => string | null
): PluginHostPanel[] {
  return plugin.manifest.contributes.panels.map((panel, index) => {
    const url = imageUrl(pluginPanelIconSlot(index), pluginPanelImageIconPath(panel.icon))
    // Why the change count for dev folders: their URL is otherwise fixed, so an edited image
    // would keep the one the button already loaded.
    const image = url && plugin.isDev ? `${url}?v=${plugin.devChangeCount ?? 0}` : url
    return {
      id: panel.id,
      title: panel.title,
      ...projectPluginPanelIcon(panel.icon, image),
      tabKey: pluginPanelTabKey(plugin.pluginKey, panel.id)
    }
  })
}
