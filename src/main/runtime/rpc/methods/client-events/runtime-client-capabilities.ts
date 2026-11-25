import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import { defineMethod } from '../../core'
import { ClientCapabilitiesUpdate } from '../../../../../shared/rpc-contract/host-management/runtime-client-capabilities-params'

export const RUNTIME_CLIENT_CAPABILITY_METHODS = [
  defineMethod({
    name: 'runtime.clientCapabilities.update',
    permission: 'workspace',
    share: 'not-shared',
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
