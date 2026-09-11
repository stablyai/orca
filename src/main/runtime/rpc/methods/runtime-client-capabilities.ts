import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { defineMethod, type RpcAnyMethod } from '../core'
import { ClientCapabilitiesUpdate } from '../../../../shared/rpc-contract/runtime-client-capabilities-params'

export const RUNTIME_CLIENT_CAPABILITY_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'runtime.clientCapabilities.update',
    params: ClientCapabilitiesUpdate,
    handler: (params, { updateClientCapabilities }) => {
      if (!updateClientCapabilities) {
        throw new Error('client_capabilities_update_unsupported')
      }
      const clientCapabilities = params.clientCapabilities as RuntimeCapability[]
      updateClientCapabilities(clientCapabilities)
      return { clientCapabilities }
    }
  })
]
