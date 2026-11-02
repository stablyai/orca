import { PLUGIN_HOST_API } from '../../../shared/plugins/workers/plugin-host-api'
import type { PluginStatusBarItemPatch } from '../../../shared/plugins/contributions/plugin-status-bar-item-contribution'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'

/** The calling plugin's status bar items; false when it declares no item with that id. */
export type PluginStatusBarServices = {
  update(pluginId: string, itemId: string, patch: PluginStatusBarItemPatch): boolean
}

const api = PLUGIN_HOST_API

export const PLUGIN_STATUS_BAR_HANDLERS = {
  'statusBar.update': bind(
    api['statusBar.update'],
    async ({ id, ...patch }, { pluginId, services }) => {
      if (!services.statusBar) {
        throw new PluginHostCallError('unavailable', 'this Orca has no status bar')
      }
      if (!services.statusBar.update(pluginId, id, patch)) {
        throw new PluginHostCallError(
          'invalid_params',
          `id: no contributes.statusBarItems entry is named ${id}`
        )
      }
      return { ok: true as const }
    }
  )
} satisfies Record<string, BoundPluginHostMethod>
