import { defineMethod, type RpcMethod } from '../../../core'
import { attachFederatedWorker } from '../../orchestration-federation-attach'
import { FederationAttachStartParams } from './federation-start-schema'

export const ORCHESTRATION_FEDERATION_ATTACH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationAttachStart',
    params: FederationAttachStartParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      return attachFederatedWorker({ params, runtime, orchestrationMutation })
    }
  })
]
