import { defineMethod } from '../core'
import {
  PluginDevEmitParams,
  PluginDevHookParams
} from '../../../../shared/rpc-contract/plugins-params'
import { firePluginDevHook } from '../../../plugins/hooks/plugin-dev-hook-fire'
import { emitPluginDevEvent } from '../../../plugins/plugin-dev-event-emit'
import { requirePluginService } from './plugins'

export const PLUGIN_DEV_EMIT_METHODS = [
  defineMethod({
    // Why host-admin: it runs plugin code on the host, like plugins.invokeCommand.
    name: 'plugins.devEmit',
    permission: 'host-admin',
    params: PluginDevEmitParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return emitPluginDevEvent({
        service,
        target:
          params.pluginKey !== undefined
            ? { pluginKey: params.pluginKey }
            : { path: params.path ?? '' },
        event: params.event,
        payload: params.payload
      })
    }
  }),
  defineMethod({
    name: 'plugins.devHook',
    permission: 'host-admin',
    params: PluginDevHookParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return firePluginDevHook({
        service,
        target:
          params.pluginKey !== undefined
            ? { pluginKey: params.pluginKey }
            : { path: params.path ?? '' },
        event: params.event,
        payload: params.payload
      })
    }
  })
]
