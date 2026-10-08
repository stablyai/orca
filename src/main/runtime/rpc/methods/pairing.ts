import { defineMethod } from '../core'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../../shared/delegated-mobile-device-contract'
import {
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'

export const PAIRING_METHODS = [
  defineMethod({
    name: 'pairing.getEndpoints',
    params: PairingGetEndpointsParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.getEndpoints(params)
    }
  }),
  defineMethod({
    name: 'pairing.provisionRelay',
    params: PairingProvisionRelayParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.provisionRelay(params)
    }
  }),
  defineMethod({
    name: DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
    params: DelegatedMobileDeviceSyncParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.delegatedMobileDevices) {
        throw new Error('runtime_device_required')
      }
      return ctx.delegatedMobileDevices.sync(params.phones)
    }
  })
]
