import { defineMethod } from '../core'
import { PairingGetDirectEndpointsParamsSchema } from '../../../../shared/pairing-direct-endpoints'
import {
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'

export const PAIRING_METHODS = [
  defineMethod({
    name: 'pairing.getDirectEndpoints',
    params: PairingGetDirectEndpointsParamsSchema,
    handler: async (_params, ctx) => {
      if (!ctx.pairing?.getDirectEndpoints) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.getDirectEndpoints()
    }
  }),
  defineMethod({
    name: 'pairing.getEndpoints',
    params: PairingGetEndpointsParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing?.getEndpoints) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.getEndpoints(params)
    }
  }),
  defineMethod({
    name: 'pairing.provisionRelay',
    params: PairingProvisionRelayParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing?.provisionRelay) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.provisionRelay(params)
    }
  })
]
