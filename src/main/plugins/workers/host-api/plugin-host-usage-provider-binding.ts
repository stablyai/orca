import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { PluginHostCallError } from './plugin-host-call-scope'
import { bind } from './plugin-host-method-bind'

export const pluginUsageProviderUpdate = bind(
  PLUGIN_HOST_API['usageProvider.update'],
  async (params, { services }) => {
    if (!services.usageProvider) {
      throw new PluginHostCallError('unavailable', 'usage providers are unavailable to this caller')
    }
    if (!services.usageProvider(params)) {
      throw new PluginHostCallError(
        'invalid_params',
        `id: no contributes.usageProviders entry is named ${params.id}`
      )
    }
    return { ok: true as const }
  }
)
