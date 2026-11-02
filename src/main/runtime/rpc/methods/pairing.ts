import { defineMethod } from '../core'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../../shared/delegated-mobile-device-contract'
import {
  ORCAD_DECLARE_CLIENT_METHOD,
  ORCAD_PEER_DESKTOPS_METHOD,
  OrcadDeclareClientParamsSchema,
  OrcadPeerDesktopsParamsSchema
} from '../../../../shared/orcad-peer-desktops-contract'
import { RegisterDeviceKeyParamsSchema } from '../../../../shared/device-key-registration-contract'
import { REGISTER_DEVICE_KEY_METHOD } from '../../../../shared/device-key-capability'
import {
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'

export const PAIRING_METHODS = [
  defineMethod({
    name: 'pairing.getEndpoints',
    permission: 'pairing-admin',
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
    permission: 'pairing-admin',
    params: PairingProvisionRelayParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.provisionRelay(params)
    }
  }),
  defineMethod({
    name: REGISTER_DEVICE_KEY_METHOD,
    permission: 'device-self',
    params: RegisterDeviceKeyParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.deviceSelf) {
        throw new Error('device_key_registration_unavailable')
      }
      return ctx.deviceSelf.registerDeviceKey(params)
    }
  }),
  defineMethod({
    name: ORCAD_PEER_DESKTOPS_METHOD,
    // Paired desktops lack pairing-admin; they learn only other desktops' names, never credentials.
    permission: 'workspace',
    params: OrcadPeerDesktopsParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.peerDesktops) {
        throw new Error('runtime_device_required')
      }
      return ctx.peerDesktops.list(params.clientInstanceId)
    }
  }),
  defineMethod({
    name: ORCAD_DECLARE_CLIENT_METHOD,
    permission: 'workspace',
    params: OrcadDeclareClientParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.peerDesktops) {
        throw new Error('runtime_device_required')
      }
      ctx.peerDesktops.declare(params.clientInstanceId)
      return {}
    }
  }),
  defineMethod({
    name: DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
    // Paired desktops lack pairing-admin but must manage their children within rpc-caller-scope.
    permission: 'workspace',
    params: DelegatedMobileDeviceSyncParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.delegatedMobileDevices) {
        throw new Error('runtime_device_required')
      }
      return ctx.delegatedMobileDevices.sync(params.phones)
    }
  })
]
