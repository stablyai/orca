import { defineMethod } from '../core'
import { PluginInvokeTaskSourceParams } from '../../../../shared/rpc-contract/plugins-params'
import { invokePluginTaskSource } from '../../../plugins/plugin-task-source-invocation'
import { requirePluginService } from './plugins'

export const PLUGIN_TASK_SOURCE_METHODS = [
  defineMethod({
    name: 'plugins.invokeTaskSource',
    // Why: lists and reads a task source's items, like plugins.readPanelEntry; it runs no commands.
    permission: 'workspace',
    params: PluginInvokeTaskSourceParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return invokePluginTaskSource(service, params)
    }
  })
]
