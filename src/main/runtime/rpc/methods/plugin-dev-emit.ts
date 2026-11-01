import { defineMethod } from '../core'
import { PluginDevEmitParams } from '../../../../shared/rpc-contract/plugins-params'
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
  })
]
