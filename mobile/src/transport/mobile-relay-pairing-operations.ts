import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema
} from '../../../src/shared/mobile-relay-credential-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'

// Preserve unwrapped transport rejections and avoid retries: lost mutation replies must retain unknown/cutover identity.
// Keep the shipped strict shared credential schemas for this native pairing boundary.

// Provision by stable reqId for idempotency; callers handle old-host unavailability before interpreting refusals.
export const relayCredentialProvision = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'pairing.provision-relay-credential',
    method: 'pairing.provisionRelay',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('credential-installed', DeviceCredentialInstalledSchema)
  })
)

// Promote credentials only from authoritative install status; provision alone never establishes a committed install.
export const relayPairingEndpointsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'pairing.relay-endpoints',
    method: 'pairing.getEndpoints',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pairing-endpoints', PairingGetEndpointsResultSchema)
  })
)
