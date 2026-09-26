import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema
} from '../../../src/shared/mobile-relay-credential-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'

// The two requests that install and reconcile a relay resume credential. Both are mutations whose
// lost reply is unknown rather than failed, so neither operation retries and neither wraps the
// transport rejection: `request` hands back the promise the transport settled, which is what keeps
// `isRpcDeliveryUnknown` and `isLogicalClientCutoverError` readable at the four call sites.
//
// Both readers are the shared credential contract itself, moved here from the four call sites that
// each ran `.parse()` on the interpreted value. Nothing about the schemas changes, including their
// `.strict()`: this is the released native app's own pairing surface and the strictness is main's
// shipped rule for it, not a new one this branch invented. What moves is where the refusal is
// raised — `RpcIncompatibleReplyError` naming the method, instead of a `ZodError` one statement
// later — and that every caller now inherits it instead of restating it.

/**
 * Authorizes one resume credential against the host's install journal, keyed by `reqId` so a
 * replay is idempotent. Every caller throws `code: message` on a refusal; two of them first read the
 * raw envelope for a host that will not serve relay pairing at all (`isPairingRelayRpcUnavailable`),
 * because that means "this build has no relay", not "the install failed". Both of those run before
 * interpretation, so the checked reader never sees a refusal.
 */
export const relayCredentialProvision = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'pairing.provision-relay-credential',
    method: 'pairing.provisionRelay',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('credential-installed', DeviceCredentialInstalledSchema)
  })
)

/**
 * The host's authoritative view: the relay endpoint, the install's committed state and, when the
 * caller names a resume confirmation, its lease. This is the only thing any of the four callers
 * will commit on — a provision reply alone never promotes a credential.
 */
export const relayPairingEndpointsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'pairing.relay-endpoints',
    method: 'pairing.getEndpoints',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pairing-endpoints', PairingGetEndpointsResultSchema)
  })
)
