import { defineMethod, type RpcAnyMethod } from '../core'
import {
  PairingCreateOfferParamsSchema,
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'

export const PAIRING_METHODS: readonly RpcAnyMethod[] = [
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
  }),
  // Why: headless / already-running hosts mint grants without the Settings UI path.
  // Must stay off MOBILE_RPC_METHOD_ALLOWLIST so phones cannot escalate to new runtime grants.
  defineMethod({
    name: 'pairing.createOffer',
    params: PairingCreateOfferParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.pairing?.createOffer) {
        throw new Error('pairing_context_unavailable')
      }
      return ctx.pairing.createOffer(params)
    }
  })
]
