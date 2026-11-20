import { defineMethod } from '../../core'
import {
  PluginDevRequestParams,
  PluginRequestParams
} from '../../../../../shared/rpc-contract/plugins/plugins-params'
import { requestPluginPanelHandler } from '../../../../plugins/cli/plugin-cli-request'
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
      return requestPluginPanelHandler({
        service,
        target: {
          dev:
            params.pluginKey !== undefined
              ? { pluginKey: params.pluginKey }
              : { path: params.path ?? '' }
        },
        name: params.name,
        input: params.input,
        panel: params.panel,
        timeoutMs: params.timeoutMs,
        signal: ctx.signal
      })
    }
  }),
  defineMethod({
    name: 'plugins.request',
    permission: 'host-admin',
    params: PluginRequestParams,
    handler: async (params, ctx) => {
      const service = requirePluginService()
      await service.whenReady()
      return requestPluginPanelHandler({
        service,
        name: params.name,
        input: params.input,
        timeoutMs: params.timeoutMs,
        target: { installed: params.pluginKey },
        signal: ctx.signal
      })
    }
  })
]
