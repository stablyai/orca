import { defineMethod } from '../core'
import type { PluginViewDesktop } from '../../../plugins/view/plugin-view-desktop'
import {
  PluginOpenParams,
  PluginShotParams,
  PluginShotReplayParams
} from '../../../../shared/rpc-contract/plugins-params'

// Desktop only: a headless `orca serve` has no window to show or capture a plugin in.
let pluginViewForRpc: PluginViewDesktop | null = null

export function setPluginViewForRpc(view: PluginViewDesktop | null): void {
  pluginViewForRpc = view
}

function requirePluginView(): PluginViewDesktop {
  if (!pluginViewForRpc) {
    throw new Error('Showing plugin panels is only available in the Orca desktop app')
  }
  return pluginViewForRpc
}

export const PLUGIN_VIEW_METHODS = [
  defineMethod({
    // Renderer state only: the window is never shown, raised or focused.
    name: 'plugins.open',
    permission: 'host-admin',
    params: PluginOpenParams,
    handler: async (params) => requirePluginView().open(params)
  }),
  defineMethod({
    name: 'plugins.shot',
    permission: 'host-admin',
    params: PluginShotParams,
    handler: async (params) => requirePluginView().shot(params)
  }),
  defineMethod({
    // Never opens the plugin's panel or reaches its guest or worker; see plugin-view-replay-shot.
    name: 'plugins.shotReplay',
    permission: 'host-admin',
    params: PluginShotReplayParams,
    handler: async (params) => requirePluginView().shotReplay(params)
  })
]
