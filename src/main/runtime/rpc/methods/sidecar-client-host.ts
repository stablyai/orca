import { SIDECAR_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  sidecarClientHostLatestParamsSchema,
  sidecarClientHostLatestResultSchema
} from '../../../../shared/plugins/plugin-sidecar-contract'
import { isQualifiedPluginKey } from '../../../../shared/plugins/plugin-manifest'
import { defineMethod, type RpcAnyMethod, type RpcContext } from '../core'
import type { PluginService } from '../../../plugins/plugin-service'
import { getPluginServiceForRpc } from './plugins'

function requirePluginService(): PluginService {
  const service = getPluginServiceForRpc()
  if (!service) {
    throw new Error('Plugin service is not available on this runtime')
  }
  return service
}

function assertSidecarClientHostCapability(context: RpcContext): void {
  if (
    context.clientCapabilities &&
    !context.clientCapabilities.includes(SIDECAR_CLIENT_HOST_RUNTIME_CAPABILITY)
  ) {
    throw new Error('sidecar.clientHost.v1 is required')
  }
}

export const SIDECAR_CLIENT_HOST_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'sidecar.clientHost.latest',
    params: sidecarClientHostLatestParamsSchema,
    handler: (params, context) => {
      assertSidecarClientHostCapability(context)
      const pluginKey = params?.pluginKey
      if (pluginKey !== undefined && !isQualifiedPluginKey(pluginKey)) {
        throw new Error('invalid qualified plugin key')
      }
      const frames = requirePluginService().sidecarMailbox.latest(pluginKey)
      return sidecarClientHostLatestResultSchema.parse({ frames })
    }
  })
]
