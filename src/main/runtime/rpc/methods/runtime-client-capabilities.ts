import { z } from 'zod'
import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { defineMethod, type RpcAnyMethod } from '../core'

const ClientCapabilitiesUpdate = z
  .object({
    clientCapabilities: z.array(z.string().min(1).max(128)).max(64)
  })
  .strict()

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
