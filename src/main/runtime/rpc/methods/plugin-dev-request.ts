import { defineMethod } from '../core'
import { PluginDevRequestParams } from '../../../../shared/rpc-contract/plugins-params'
import { requestPluginDevPanelHandler } from '../../../plugins/plugin-dev-panel-request'
import { requirePluginService } from './plugins'

export const PLUGIN_DEV_REQUEST_METHODS = [
  defineMethod({
    // Why host-admin: it runs plugin code on the host, like plugins.devEmit.
    name: 'plugins.devRequest',
    permission: 'host-admin',
    params: PluginDevRequestParams,
    handler: async (params, ctx) => {
      const service = requirePluginService()
      await service.whenReady()
      return requestPluginDevPanelHandler({
        service,
        target:
          params.pluginKey !== undefined
            ? { pluginKey: params.pluginKey }
            : { path: params.path ?? '' },
        name: params.name,
        input: params.input,
        panel: params.panel,
        timeoutMs: params.timeoutMs,
        signal: ctx.signal
      })
    }
  })
]
